"""PyFlink job: geofence breach detection over vehicle telemetry.

Topology:

    vehicle-telemetry (Kinesis, keyed by vehicleId) ---.
                                                        >-- KeyedBroadcastProcessFunction --> geofence-alerts (Kinesis)
    geofence-rules    (Kinesis, broadcast) ------------'

The per-position decision logic lives in ``detector.evaluate_position`` and is unit
tested as a local mini-run; this module is the thin Flink adapter that maps Flink
**broadcast state** (the active zone set) and **keyed state** (per-vehicle in/out
flags) onto it.

Scope boundary: this module does NOT configure checkpointing or parallelism —
Managed Service for Apache Flink sets those at the application level, not in app
code. The Kinesis source/sink connector classes and runtime properties (stream
names, region, starting position) are supplied by the CDK Flink application in the
next task; ``main`` shows the intended shape and is exercised end to end at deploy.

Resilience: the actual decision logic — parsing, the bootstrap hold-and-replay, and
poison-record handling — lives in ``detector`` and is unit-tested there. This adapter
only maps that logic onto Flink state:
- Bootstrap gate: telemetry that arrives before any zone is in broadcast state is
  buffered in keyed state and drained once a rule loads, so a vehicle's baseline is
  never taken from pre-rule positions. The primary mitigation stays at the source:
  the CDK app reads ``geofence-rules`` from the stream start (TRIM_HORIZON) so rules
  load ahead of telemetry; this buffer is the belt-and-suspenders app-level guard.
- Poison telemetry: a non-deserializable record is dropped and counted on a metric,
  never allowed to stall the shard.
"""

import json

from pyflink.common import Types
from pyflink.datastream import StreamExecutionEnvironment, KeyedBroadcastProcessFunction
from pyflink.datastream.state import MapStateDescriptor, ListStateDescriptor

from detector import evaluate_position, parse_telemetry, PoisonRecord

# Stream names; overridable via MSF runtime properties when the CDK Flink app is wired.
TELEMETRY_STREAM = "vehicle-telemetry"
RULES_STREAM = "geofence-rules"
ALERTS_STREAM = "geofence-alerts"

# Broadcast state: active zones keyed by zone id, value is the zone-change JSON.
ZONES_DESCRIPTOR = MapStateDescriptor("active-zones", Types.STRING(), Types.STRING())


class GeofenceBroadcastFunction(KeyedBroadcastProcessFunction):
    """Active zones as broadcast state; per-vehicle in/out flags as keyed state.

    Both the topology and this class are deliberately thin: the decision is made by
    the pure ``evaluate_position`` so it stays unit-testable off-cluster.
    """

    def open(self, runtime_context):
        # Per-vehicle, per-zone last inside flag (keyed by the vehicleId key).
        self._inside = runtime_context.get_map_state(
            MapStateDescriptor("vehicle-inside", Types.STRING(), Types.BOOLEAN())
        )
        # Telemetry held (per vehicle) until the first zone loads — the bootstrap gate.
        self._pending = runtime_context.get_list_state(
            ListStateDescriptor("pending-telemetry", Types.STRING())
        )
        # Poison telemetry drop counter, surfaced as a Flink metric.
        self._dropped = runtime_context.get_metrics_group().counter("poisonTelemetryDropped")

    def process_broadcast_element(self, value, ctx):
        change = json.loads(value)
        zones = ctx.get_broadcast_state(ZONES_DESCRIPTOR)
        zone_id = change["id"]
        if change.get("op") == "REMOVE" or not change.get("active", False):
            if zones.contains(zone_id):
                zones.remove(zone_id)
        else:
            zones.put(zone_id, value)
        # A rule change updates state and emits nothing. Telemetry held during the
        # bootstrap window is drained lazily by the owning key on its next element.

    def _evaluate(self, telemetry, zones):
        prev_inside = {
            zid: self._inside.get(zid) for zid in zones if self._inside.contains(zid)
        }
        breaches, updated = evaluate_position(telemetry, zones, prev_inside)
        for zone_id, inside in updated.items():
            self._inside.put(zone_id, inside)
        return breaches

    def process_element(self, value, ctx):
        try:
            telemetry = parse_telemetry(value)
        except PoisonRecord:
            self._dropped.inc()  # drop and count; the shard keeps moving
            return

        zones_state = ctx.get_broadcast_state(ZONES_DESCRIPTOR)
        zones = {zid: json.loads(zone) for zid, zone in zones_state.items()}

        if not zones:
            # Bootstrap gate: no zone loaded yet, so hold this position rather than
            # let it set a baseline that would miss the first real crossing.
            self._pending.add(value)
            return

        # Zones are loaded: drain anything held during bootstrap (in arrival order),
        # then evaluate the current position.
        pending = list(self._pending.get())
        if pending:
            self._pending.clear()
            for raw in pending:
                try:
                    held = parse_telemetry(raw)
                except PoisonRecord:
                    self._dropped.inc()
                    continue
                for breach in self._evaluate(held, zones):
                    yield json.dumps(breach)
        for breach in self._evaluate(telemetry, zones):
            yield json.dumps(breach)


def build_pipeline(telemetry_stream, rules_stream):
    """Wire telemetry (keyed by vehicleId) + broadcast rules into the breach stream.

    Connector-agnostic so the topology is reviewable without a running cluster:
    callers pass already-constructed source streams and sink the returned stream.
    """
    keyed = telemetry_stream.key_by(lambda record: json.loads(record)["vehicleId"])
    broadcast = rules_stream.broadcast(ZONES_DESCRIPTOR)
    return (
        keyed.connect(broadcast)
        .process(GeofenceBroadcastFunction(), output_type=Types.STRING())
    )


def main():
    env = StreamExecutionEnvironment.get_execution_environment()
    # The Kinesis source/sink construction (connector classes + runtime properties:
    # stream names above, region, starting position) is provided by the CDK Flink
    # application and validated in the live run. The topology it feeds is build_pipeline:
    #
    #   telemetry = <KinesisSource(TELEMETRY_STREAM)>
    #   rules     = <KinesisSource(RULES_STREAM)>
    #   build_pipeline(telemetry, rules).sink_to(<KinesisSink(ALERTS_STREAM)>)
    #   env.execute("geofence-breach-detection")
    raise NotImplementedError(
        "Kinesis connector wiring is supplied by the CDK Flink application (next task)."
    )


if __name__ == "__main__":
    main()
