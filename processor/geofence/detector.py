"""Breach detection: the decision logic the stream processor runs per position.

Kept pure (no Flink, no AWS) so it unit-tests as a local mini-run and the Flink
job is a thin adapter over it. The job holds the active zone set as broadcast state
and per-vehicle in/out flags as keyed state; here those are plain dicts.

A breach is a boundary *crossing* whose direction violates the zone's semantics:
- exclusion (no-go): entering is a breach;
- containment (keep-in): leaving is a breach;
- dwell: arrival and departure are both reported.

The processor emits FACTS only — which zone, which crossing, where, how far outside,
the vehicle diagnostics passthrough. It assigns no severity or reason; that is the
triage layer's job.
"""

import json
from collections import deque

from geometry import point_in_polygon, distance_to_boundary_m
from edges import detect_edge, ENTRY, EXIT

# Cap on telemetry held during the bootstrap window (before the first rule loads).
# The window is sub-second in practice (rules replay from the stream's start ahead
# of telemetry), so this only bounds memory in a pathological rules-never-arrive
# case; the oldest held positions are dropped once it fills.
BOOTSTRAP_HOLD_CAP = 1000


class PoisonRecord(Exception):
    """A telemetry record that cannot be turned into an evaluable position."""


def parse_telemetry(raw):
    """Deserialize and minimally validate one telemetry record.

    Accepts a JSON string (as it arrives off the stream) or an already-parsed dict.
    Raises ``PoisonRecord`` for anything the detector cannot evaluate — the caller
    drops and counts it rather than stalling the shard.
    """
    if isinstance(raw, (str, bytes, bytearray)):
        try:
            record = json.loads(raw)
        except (ValueError, TypeError) as exc:
            raise PoisonRecord(f"undecodable telemetry: {exc}")
    else:
        record = raw
    if not isinstance(record, dict):
        raise PoisonRecord("telemetry is not a JSON object")
    if not record.get("vehicleId"):
        raise PoisonRecord("telemetry missing vehicleId")
    location = record.get("location")
    if not isinstance(location, dict) or location.get("latitude") is None or location.get("longitude") is None:
        raise PoisonRecord("telemetry missing location latitude/longitude")
    return record


def _is_breach(kind, edge):
    """Does this crossing violate the zone's semantics?"""
    if kind == "exclusion":
        return edge == ENTRY
    if kind == "containment":
        return edge == EXIT
    if kind == "dwell":
        return edge in (ENTRY, EXIT)
    return False


def _vehicle_passthrough(telemetry):
    """Lift the diagnostic signals the triage layer reasons over (best-effort)."""
    vss = telemetry.get("vss", {})
    location = telemetry.get("location", {})
    return {
        "speed": location.get("speed"),
        "ignition": vss.get("vehicle.ignition"),
        "fuelLevel": vss.get("vehicle.fuel.level"),
        "gear": vss.get("vehicle.transmission.gear"),
        "engineTemperature": vss.get("vehicle.powertrain.engine.temperature"),
        "brakeFluidLevel": vss.get(
            "vehicle.chassis.axle.row1.wheel.left.brake.fluidLevel"
        ),
        "doorOpen": vss.get("vehicle.cabin.door.row1.left.isOpen"),
    }


def _breach_event(telemetry, zone, edge, inside):
    location = telemetry.get("location", {})
    lat, lon = location.get("latitude"), location.get("longitude")
    # How far OUTSIDE the polygon the vehicle is: 0 when inside (e.g. an exclusion
    # entry), the metre distance to the boundary when outside (a containment exit).
    distance_outside = 0.0 if inside else distance_to_boundary_m(lat, lon, zone["polygon"])
    return {
        "vehicleId": telemetry["vehicleId"],
        "zoneId": zone["id"],
        # name is not carried on rule-change records yet (see follow-up); fall back to id
        "zoneName": zone.get("name") or zone["id"],
        "zoneKind": zone.get("kind"),
        "breachType": edge,  # entry | exit
        "timestamp": telemetry.get("timestamp"),
        "location": {"latitude": lat, "longitude": lon, "accuracy": location.get("accuracy")},
        "distanceOutsideM": round(distance_outside, 1),
        # The crossing just happened, so time-in-state is ~0; sustained-dwell
        # duration (re-emit / enrich) is a deferred enhancement.
        "durationInStateS": 0,
        "vehicle": _vehicle_passthrough(telemetry),
    }


def evaluate_position(telemetry, zones, prev_inside):
    """Test one position against all active zones.

    `zones`: dict zone_id -> {id, name, kind, polygon, properties}.
    `prev_inside`: dict zone_id -> bool (this vehicle's last in/out per zone; a
    missing/None entry means no prior observation, so no crossing is inferred).

    Returns (breach_events, updated_inside).
    """
    location = telemetry.get("location", {})
    lat, lon = location.get("latitude"), location.get("longitude")

    breaches = []
    updated = dict(prev_inside)
    for zone_id, zone in zones.items():
        inside = point_in_polygon(lat, lon, zone["polygon"])
        edge = detect_edge(prev_inside.get(zone_id), inside)
        updated[zone_id] = inside
        if edge is not None and _is_breach(zone.get("kind"), edge):
            breaches.append(_breach_event(telemetry, zone, edge, inside))
    return breaches, updated


class Detector:
    """Stateful driver for local runs and tests (the job uses Flink state instead).

    Holds the active zone set and per-vehicle in/out flags, mirroring the job's
    broadcast + keyed state so a fixture sequence reproduces the job's behaviour.
    """

    def __init__(self):
        self.zones = {}
        self._vehicle_inside = {}  # vehicle_id -> {zone_id: inside}
        # Bootstrap gate: telemetry seen before the first active zone loads is held,
        # not evaluated, so a vehicle's in/out baseline is never established from
        # pre-rule positions (which would miss the first real crossing). The held
        # telemetry is replayed the moment the first zone activates.
        self._bootstrapped = False
        self._held = deque(maxlen=BOOTSTRAP_HOLD_CAP)
        self.dropped = 0  # count of poison telemetry records dropped

    def apply_rule_change(self, change):
        """Add/replace or drop a zone from the active set.

        Returns the breach events produced by replaying any telemetry held during
        the bootstrap window, which is non-empty only on the rule change that first
        activates a zone; an empty list otherwise.
        """
        zone_id = change["id"]
        if change.get("op") == "REMOVE" or not change.get("active", False):
            self.zones.pop(zone_id, None)
        else:
            self.zones[zone_id] = {
                "id": zone_id,
                "name": change.get("name") or zone_id,
                "kind": change.get("kind"),
                "polygon": change.get("polygon"),
                "properties": change.get("properties", {}),
            }
        if not self._bootstrapped and self.zones:
            return self._flush_held()
        return []

    def _flush_held(self):
        """Mark bootstrapped and replay held telemetry in arrival order."""
        self._bootstrapped = True
        held, self._held = list(self._held), deque(maxlen=BOOTSTRAP_HOLD_CAP)
        breaches = []
        for telemetry in held:
            breaches.extend(self._evaluate(telemetry))
        return breaches

    def process_raw(self, raw):
        """Parse a raw telemetry record then process it; drop+count poison records."""
        try:
            telemetry = parse_telemetry(raw)
        except PoisonRecord:
            self.dropped += 1
            return []
        return self.process(telemetry)

    def process(self, telemetry):
        """Return the breach events (if any) for one telemetry position.

        Before the first zone loads, hold the position instead of evaluating it (see
        the bootstrap gate above) and return no breaches.
        """
        if not self._bootstrapped:
            self._held.append(telemetry)
            return []
        return self._evaluate(telemetry)

    def _evaluate(self, telemetry):
        vehicle_id = telemetry["vehicleId"]
        prev = self._vehicle_inside.get(vehicle_id, {})
        breaches, updated = evaluate_position(telemetry, self.zones, prev)
        self._vehicle_inside[vehicle_id] = updated
        return breaches
