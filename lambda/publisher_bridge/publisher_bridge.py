"""Publisher bridge: SQS alert-queue -> InvokeAgentRuntime(publisher).

Adapts the SQS delivery queue to ``bedrock-agentcore:InvokeAgentRuntime``, one
surviving alert per message. Reports partial-batch failures (finding R1) so a bad
message or transient invoke error retries just that message; the queue's redrive
policy moves what still fails to the DLQ.

``decode_record`` is pure (SQS body -> alert dict) and unit-tested; boto3 is
imported lazily.
"""

import json
import os

PUBLISHER_RUNTIME_ARN = os.environ.get("PUBLISHER_RUNTIME_ARN", "")

_agentcore = None


def decode_record(record):
    """SQS record -> alert dict. Raises on an undecodable body."""
    return json.loads(record["body"])


def _client():
    global _agentcore
    if _agentcore is None:
        import boto3

        _agentcore = boto3.client("bedrock-agentcore")
    return _agentcore


def _invoke(alert):
    _client().invoke_agent_runtime(
        agentRuntimeArn=PUBLISHER_RUNTIME_ARN,
        payload=json.dumps(alert).encode("utf-8"),
        contentType="application/json",
    )


def handler(event, _context=None):
    """Invoke the publisher per alert; report the messages that failed."""
    failures = []
    for record in event.get("Records", []):
        message_id = record.get("messageId")
        try:
            _invoke(decode_record(record))
        except Exception:  # noqa: BLE001 - fail just this message, keep the batch moving
            if message_id is not None:
                failures.append({"itemIdentifier": message_id})
    return {"batchItemFailures": failures}
