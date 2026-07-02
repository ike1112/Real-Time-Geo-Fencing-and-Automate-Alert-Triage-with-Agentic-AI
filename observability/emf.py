"""CloudWatch Embedded Metric Format documents for the triage sub-hop latencies.

Publishing per-hop latency with PutMetricData would add a synchronous, throttleable
API call to the triage hot path. Instead the 003 bridges/runtimes print an EMF log
line and CloudWatch extracts the metric asynchronously from logs.

Emission points (stage dimension in parentheses):
  analyzer  — analyzerRead -> bedrockDone -> sqsEnqueue   => TriageBedrock (analyzer)
  publisher — publisherRead -> snsPublish                 => NotifyTotal   (publisher)

This module is the pure document builder; callers print `json.dumps(document(...))`.
"""

NAMESPACE = "Geofence/Latency"


def document(metrics, stage, timestamp_ms=None):
    """Build one EMF document.

    ``metrics`` is a ``{metricName: valueMs}`` dict; ``stage`` is the dimension value.
    Only metrics with a non-None value are included so a missing stamp drops that hop.
    """
    values = {name: value for name, value in metrics.items() if value is not None}
    doc = {
        "_aws": {
            "CloudWatchMetrics": [
                {
                    "Namespace": NAMESPACE,
                    "Dimensions": [["stage"]],
                    "Metrics": [{"Name": name, "Unit": "Milliseconds"} for name in values],
                }
            ],
        },
        "stage": stage,
    }
    if timestamp_ms is not None:
        doc["_aws"]["Timestamp"] = timestamp_ms
    doc.update(values)
    return doc


def _delta(stamps, start, end):
    a, b = stamps.get(start), stamps.get(end)
    return (b - a) if (a is not None and b is not None) else None


def analyzer_document(stamps):
    """TriageBedrock (analyzerRead -> bedrockDone) + queue enqueue, stage 'analyzer'."""
    return document(
        {
            "TriageBedrock": _delta(stamps, "analyzerRead", "bedrockDone"),
            "SqsEnqueue": _delta(stamps, "bedrockDone", "sqsEnqueue"),
        },
        stage="analyzer",
        timestamp_ms=stamps.get("sqsEnqueue"),
    )


def publisher_document(stamps):
    """NotifyTotal (publisherRead -> snsPublish), stage 'publisher'."""
    return document(
        {"NotifyTotal": _delta(stamps, "publisherRead", "snsPublish")},
        stage="publisher",
        timestamp_ms=stamps.get("snsPublish"),
    )
