"""Local mini-run: drive fixture telemetry + rule changes through the detector.

Proves AC1 (one correctly-typed breach per violating crossing) and AC4 (no false
breaches from staying put or from a non-violating crossing).
"""

import json

from detector import Detector

# Two square zones (closed rings of [lat, lon]).
EXCLUSION = {
    "op": "INSERT", "id": "zone-excl", "active": True, "kind": "exclusion",
    "polygon": [[0, 0], [0, 2], [2, 2], [2, 0], [0, 0]],
    "properties": {"type": "exclusion"},
}
CONTAINMENT = {
    "op": "INSERT", "id": "zone-cont", "active": True, "kind": "containment",
    "polygon": [[10, 10], [10, 12], [12, 12], [12, 10], [10, 10]],
    "properties": {"type": "containment"},
}
DWELL = {
    "op": "INSERT", "id": "zone-dwell", "active": True, "kind": "dwell",
    "polygon": [[20, 20], [20, 22], [22, 22], [22, 20], [20, 20]],
    "properties": {"type": "dwell"},
}


def _ping(vehicle_id, lat, lon, ts=1000, accuracy=3.0):
    return {
        "vehicleId": vehicle_id,
        "timestamp": ts,
        "location": {"latitude": lat, "longitude": lon, "accuracy": accuracy},
        "vss": {"vehicle.ignition": True, "vehicle.speed": 40.0},
    }


def _detector(*rule_changes):
    d = Detector()
    for change in rule_changes:
        d.apply_rule_change(change)
    return d


def test_exclusion_entry_emits_one_entry_breach():
    d = _detector(EXCLUSION)
    assert d.process(_ping("veh-1", 5, 5)) == []          # outside, first sighting
    breaches = d.process(_ping("veh-1", 1, 1))            # crosses IN
    assert len(breaches) == 1
    b = breaches[0]
    assert (b["vehicleId"], b["zoneId"], b["breachType"]) == ("veh-1", "zone-excl", "entry")
    assert b["zoneKind"] == "exclusion"
    assert b["distanceOutsideM"] == 0.0                    # inside a no-go zone


def test_exclusion_no_duplicate_while_staying_inside():
    d = _detector(EXCLUSION)
    d.process(_ping("veh-1", 5, 5))
    d.process(_ping("veh-1", 1, 1))                        # entry breach
    assert d.process(_ping("veh-1", 1.5, 1.5)) == []       # still inside -> no re-breach


def test_exclusion_exit_is_not_a_breach():
    d = _detector(EXCLUSION)
    d.process(_ping("veh-1", 1, 1))                        # starts inside (first sighting, no edge)
    assert d.process(_ping("veh-1", 5, 5)) == []           # leaving a no-go zone is fine


def test_containment_exit_emits_one_exit_breach_with_distance():
    d = _detector(CONTAINMENT)
    assert d.process(_ping("veh-2", 11, 11)) == []         # inside the yard, first sighting
    breaches = d.process(_ping("veh-2", 15, 15))           # crosses OUT
    assert len(breaches) == 1
    b = breaches[0]
    assert (b["zoneId"], b["breachType"]) == ("zone-cont", "exit")
    assert b["distanceOutsideM"] > 0.0                     # measurably outside the yard


def test_containment_return_is_not_a_breach():
    d = _detector(CONTAINMENT)
    d.process(_ping("veh-2", 15, 15))                      # outside, first sighting
    assert d.process(_ping("veh-2", 11, 11)) == []         # returning to the yard is fine


def test_dwell_reports_both_arrival_and_departure():
    d = _detector(DWELL)
    d.process(_ping("veh-3", 25, 25))                      # outside, first sighting
    arrival = d.process(_ping("veh-3", 21, 21))            # in
    departure = d.process(_ping("veh-3", 25, 25))          # out
    assert [b["breachType"] for b in arrival] == ["entry"]
    assert [b["breachType"] for b in departure] == ["exit"]


def test_vehicle_staying_in_allowed_area_never_breaches():
    # outside the exclusion zone, inside the containment zone, for its whole trip
    d = _detector(EXCLUSION, CONTAINMENT)
    for lat, lon in [(11, 11), (11.2, 11.2), (11.5, 11.5), (11.1, 10.9)]:
        assert d.process(_ping("veh-4", lat, lon)) == []


def test_no_breach_before_any_rule_is_loaded():
    # bootstrap safety: telemetry arriving before zones are known produces nothing
    d = Detector()
    assert d.process(_ping("veh-5", 1, 1)) == []


def test_deactivating_a_zone_stops_breaches():
    d = _detector(EXCLUSION)
    d.process(_ping("veh-6", 5, 5))
    assert len(d.process(_ping("veh-6", 1, 1))) == 1       # entry breach while active
    d.apply_rule_change({"op": "MODIFY", "id": "zone-excl", "active": False})
    d.process(_ping("veh-6", 5, 5))                        # leave
    assert d.process(_ping("veh-6", 1, 1)) == []           # re-enter, but zone is gone


# --- Bootstrap gate (T13): telemetry before the first rule is held, not lost. ---

def test_bootstrap_holds_telemetry_then_replays_the_missed_crossing():
    # Same crossing, before vs after the rule loads. Held while no zone is known,
    # then replayed the instant the zone activates so the entry is NOT missed.
    d = Detector()
    assert d.process(_ping("veh-7", 5, 5)) == []           # outside, held (no rules yet)
    assert d.process(_ping("veh-7", 1, 1)) == []           # crosses IN, but still held
    breaches = d.apply_rule_change(EXCLUSION)              # first zone -> replay held
    assert [b["breachType"] for b in breaches] == ["entry"]
    assert breaches[0]["vehicleId"] == "veh-7"


def test_bootstrap_does_not_invent_a_breach_for_a_vehicle_that_stayed_outside():
    d = Detector()
    d.process(_ping("veh-8", 5, 5))                        # outside, held
    d.process(_ping("veh-8", 6, 6))                        # still outside, held
    assert d.apply_rule_change(EXCLUSION) == []            # replay: no crossing, no breach


# --- Poison telemetry (T14): drop and count, never stall. ---

def test_poison_telemetry_is_dropped_counted_and_does_not_stall():
    d = _detector(EXCLUSION)
    assert d.process_raw("{not valid json") == []          # undecodable -> dropped
    assert d.process_raw(json.dumps({"location": {"latitude": 1, "longitude": 1}})) == []  # no vehicleId
    assert d.process_raw(json.dumps({"vehicleId": "veh-9"})) == []  # no location
    assert d.dropped == 3
    # The shard keeps going: a good record after the poison ones still breaches.
    d.process_raw(json.dumps(_ping("veh-9", 5, 5)))
    breaches = d.process_raw(json.dumps(_ping("veh-9", 1, 1)))
    assert len(breaches) == 1 and breaches[0]["breachType"] == "entry"
    assert d.dropped == 3                                   # a valid record is not counted
