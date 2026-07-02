"""Alert Analyzer AgentCore runtime entrypoint (thin adapter).

All deterministic logic — the rubric, output parsing, the suppression gate, the
dedupe key — lives in ``triage`` and is unit-tested there; the throttle backoff
lives in ``retry``. This module only wires those onto the live services:

    InvokeAgentRuntime(payload=breach)
      -> retrieve per-vehicle history from AgentCore Memory
      -> ask the model (Strands) to triage against the rubric, with backoff
      -> write the event back to Memory
      -> if the gate passes, SendMessage to the alert queue
      -> return the decision (also captured in the OTEL trace)

Like the Flink job's ``main``, the live SDK wiring is exercised end to end at
deploy (see verify.md); the imports below are the AgentCore/Strands runtime
contract and are not part of the unit-test surface.
"""

import json
import os

import boto3
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from bedrock_agentcore.memory import MemoryClient
from strands import Agent
from strands.models import BedrockModel

import triage
from retry import call_with_retry

MODEL_ID = os.environ["BEDROCK_MODEL_ID"]
MEMORY_ID = os.environ.get("MEMORY_ID", "")
ALERT_QUEUE_URL = os.environ.get("ALERT_QUEUE_URL", "")
VIOLATIONS_NAMESPACE = "/violations/{actorId}"

app = BedrockAgentCoreApp()
_memory = MemoryClient() if MEMORY_ID else None
_sqs = boto3.client("sqs")
_agent = Agent(model=BedrockModel(model_id=MODEL_ID), system_prompt=triage.SYSTEM_PROMPT)


def _retrieve_history(vehicle_id):
    """Prior violation records for this vehicle from semantic Memory (best-effort)."""
    if not _memory:
        return []
    namespace = VIOLATIONS_NAMESPACE.format(actorId=vehicle_id)
    records = _memory.retrieve_memory_records(
        memory_id=MEMORY_ID, namespace=namespace, search_query="prior geofence breach", max_results=5
    )
    return records or []


def _remember(vehicle_id, breach, decision):
    if not _memory:
        return
    _memory.create_memory_record(
        memory_id=MEMORY_ID,
        namespace=VIOLATIONS_NAMESPACE.format(actorId=vehicle_id),
        content=json.dumps({"breach": breach, "decision": {
            "severity": decision["severity"], "reason": decision["reason"],
            "eventTime": decision["eventTime"]}}),
    )


@app.entrypoint
def invoke(payload):
    """Triage one breach event; forward only HIGH/CRITICAL to the delivery queue."""
    breach = payload if isinstance(payload, dict) else json.loads(payload)
    vehicle_id = breach.get("vehicleId", "unknown")

    history = _retrieve_history(vehicle_id)
    user_message = triage.build_user_message(breach, history)
    result = call_with_retry(lambda: _agent(user_message))
    decision = triage.parse_decision(str(result), breach)

    _remember(vehicle_id, breach, decision)

    delivered = False
    if triage.should_deliver(decision) and ALERT_QUEUE_URL:
        message = triage.to_delivery_message(breach, decision)
        _sqs.send_message(
            QueueUrl=ALERT_QUEUE_URL,
            MessageBody=json.dumps(message),
            MessageAttributes={"dedupeKey": {"DataType": "String", "StringValue": message["dedupeKey"]}},
        )
        delivered = True

    return {"decision": decision, "delivered": delivered}


if __name__ == "__main__":
    app.run()
