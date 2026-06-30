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
"""

import json

from pyflink.common import Types
from pyflink.datastream import StreamExecutionEnvironment, KeyedBroadcastProcessFunction
from pyflink.datastream.state import MapStateDescriptor

from detector import evaluate_position

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

    def process_broadcast_element(self, value, ctx):
        change = json.loads(value)
        zones = ctx.get_broadcast_state(ZONES_DESCRIPTOR)
        zone_id = change["id"]
        if change.get("op") == "REMOVE" or not change.get("active", False):
            if zones.contains(zone_id):
                zones.remove(zone_id)
        else:
            zones.put(zone_id, value)
        # A rule change updates state and emits nothing.

    def process_element(self, value, ctx):
        telemetry = json.loads(value)
        zones_state = ctx.get_broadcast_state(ZONES_DESCRIPTOR)
        zones = {zid: json.loads(zone) for zid, zone in zones_state.items()}

        prev_inside = {
            zid: self._inside.get(zid) for zid in zones if self._inside.contains(zid)
        }
        breaches, updated = evaluate_position(telemetry, zones, prev_inside)

        for zone_id, inside in updated.items():
            self._inside.put(zone_id, inside)
        for breach in breaches:
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
