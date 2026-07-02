"""Latency accumulation from the breach event's in-band `trace` stamps (pure).

The pipeline carries per-hop timestamps in the record (Kinesis/Flink don't propagate
trace context), and latency is the delta between consecutive stamps. This module is
the arithmetic over those stamps — used by the Flink adapter to stamp its own read/
emit times and report the detection-side hop metrics, and mirrored by the offline
probe (tools/verify) on the consumer side.

Stamp set (epoch millis):
  t0 eventTime   - producer (telemetry `timestamp`)
  t1 ingestTime  - IoT rule `timestamp()`
  t2 streamArrival - Kinesis ApproximateArrivalTimestamp (consumer-side; passed in)
  t3 flinkRead   - Flink read the record
  t4 flinkEmit   - Flink emitted the breach
"""

# Hop name -> (start stamp, end stamp). streamArrival (t2) is not in the record; it
# is supplied by the caller (the Flink source / the probe) when known.
_HOPS = (
    ("SourceToIoT", "eventTime", "ingestTime"),      # t0 -> t1
    ("StreamWait", "streamArrival", "flinkRead"),    # t2 -> t3
    ("FlinkProcess", "flinkRead", "flinkEmit"),      # t3 -> t4
    ("DetectionTotal", "eventTime", "flinkEmit"),    # t0 -> t4 (cumulative)
)


def stamp_flink(breach, flink_read, flink_emit):
    """Record the Flink read/emit processing-time stamps into the breach trace."""
    trace = breach.setdefault("trace", {})
    trace["flinkRead"] = flink_read
    trace["flinkEmit"] = flink_emit
    return breach


def hop_latencies(trace, stream_arrival=None):
    """Per-hop deltas from the available stamps (ms).

    Only hops whose both endpoints are present are returned, so a missing stamp
    drops that hop rather than producing a bogus number.
    """
    stamps = dict(trace or {})
    if stream_arrival is not None:
        stamps["streamArrival"] = stream_arrival
    hops = {}
    for name, start, end in _HOPS:
        a, b = stamps.get(start), stamps.get(end)
        if a is not None and b is not None:
            hops[name] = b - a
    return hops


def emit_flink_metrics(sink, trace, stream_arrival=None):
    """Report the detection-side hops (StreamWait, FlinkProcess) to a metric sink.

    ``sink`` is any callable ``(name, value_ms) -> None`` — the Flink adapter passes
    a closure over its registered metric gauges; tests pass a list-appender. Only the
    two Flink-owned hops are emitted here; the cumulative totals come from the probe.
    """
    hops = hop_latencies(trace, stream_arrival)
    for name in ("StreamWait", "FlinkProcess"):
        if name in hops:
            sink(name, hops[name])
    return hops
