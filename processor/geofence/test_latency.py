"""Latency arithmetic + trace stamping (004): the detection-side hop deltas."""

from detector import Detector
from latency import stamp_flink, hop_latencies, emit_flink_metrics


EXCLUSION = {
    "op": "INSERT", "id": "zone-excl", "active": True, "kind": "exclusion",
    "polygon": [[0, 0], [0, 2], [2, 2], [2, 0], [0, 0]],
}


def _ping(lat, lon, ts=1000, ingest=None):
    msg = {"vehicleId": "veh-1", "timestamp": ts,
           "location": {"latitude": lat, "longitude": lon, "accuracy": 3.0}}
    if ingest is not None:
        msg["ingestTime"] = ingest
    return msg


def test_breach_carries_a_trace_block_with_producer_and_ingest_stamps():
    d = Detector()
    d.apply_rule_change(EXCLUSION)
    d.process(_ping(5, 5, ts=1000, ingest=1180))     # outside, baseline
    breaches = d.process(_ping(1, 1, ts=2000, ingest=2180))   # crosses in
    trace = breaches[0]["trace"]
    assert trace["eventTime"] == 2000 and trace["ingestTime"] == 2180
    assert "flinkRead" not in trace                   # adapter fills these later


def test_stamp_flink_then_hop_latencies_computes_every_reachable_hop():
    breach = {"trace": {"eventTime": 1000, "ingestTime": 1180}}
    stamp_flink(breach, flink_read=1520, flink_emit=1523)
    hops = hop_latencies(breach["trace"], stream_arrival=1400)
    assert hops["SourceToIoT"] == 180        # t1 - t0
    assert hops["StreamWait"] == 120         # t3 - t2
    assert hops["FlinkProcess"] == 3         # t4 - t3
    assert hops["DetectionTotal"] == 523     # t4 - t0


def test_hop_latencies_skips_hops_with_a_missing_endpoint():
    # No stream arrival and no flink stamps -> only the source->ingest hop resolves.
    hops = hop_latencies({"eventTime": 1000, "ingestTime": 1180})
    assert hops == {"SourceToIoT": 180}


def test_emit_flink_metrics_reports_only_the_two_flink_hops():
    reported = []
    trace = {"eventTime": 1000, "ingestTime": 1180, "flinkRead": 1520, "flinkEmit": 1523}
    emit_flink_metrics(lambda name, value: reported.append((name, value)), trace, stream_arrival=1400)
    assert dict(reported) == {"StreamWait": 120, "FlinkProcess": 3}
