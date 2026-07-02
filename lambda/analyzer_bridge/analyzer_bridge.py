"""Analyzer bridge: Kinesis geofence-alerts -> InvokeAgentRuntime(analyzer).

AgentCore runtimes are invoked, not event-source-mapped, so this Lambda adapts the
Kinesis stream to ``bedrock-agentcore:InvokeAgentRuntime``, one breach event per
record. It reports partial-batch failures (finding R1) so a single bad record or a
transient invoke error retries just that record, not the whole batch; the ESM's
on-failure destination (a DLQ) catches what still fails.

``decode_record`` is pure (base64 -> breach dict) and unit-tested; boto3 is imported
lazily so the decoder and its tests run without it.
"""

import base64
import json
import os

ANALYZER_RUNTIME_ARN = os.environ.get("ANALYZER_RUNTIME_ARN", "")

_agentcore = None


def decode_record(record):
    """Kinesis record -> breach event dict. Raises on undecodable data."""
    data = record["kinesis"]["data"]
    raw = base64.b64decode(data)
    return json.loads(raw)


def _client():
    global _agentcore
    if _agentcore is None:
        import boto3

        _agentcore = boto3.client("bedrock-agentcore")
    return _agentcore


def _invoke(breach):
    _client().invoke_agent_runtime(
        agentRuntimeArn=ANALYZER_RUNTIME_ARN,
        payload=json.dumps(breach).encode("utf-8"),
        contentType="application/json",
    )


def handler(event, _context=None):
    """Invoke the analyzer per breach; report the records that failed."""
    failures = []
    for record in event.get("Records", []):
        sequence_number = record.get("kinesis", {}).get("sequenceNumber")
        try:
            _invoke(decode_record(record))
        except Exception:  # noqa: BLE001 - fail just this record, keep the batch moving
            if sequence_number is not None:
                failures.append({"itemIdentifier": sequence_number})
    return {"batchItemFailures": failures}
