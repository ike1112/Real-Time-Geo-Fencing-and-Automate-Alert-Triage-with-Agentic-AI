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
    """Prior violation records for this vehicle from semantic Memory (best-effort).

    Memory is a signal, never a hard dependency — a retrieval failure must not block
    triage, so any error degrades to "no history".
    """
    if not _memory:
        return []
    try:
        namespace = VIOLATIONS_NAMESPACE.format(actorId=vehicle_id)
        result = _memory.retrieve_memories(
            memory_id=MEMORY_ID, namespace=namespace,
            query="prior geofence breach", top_k=5,
        )
        return result or []
    except Exception:  # noqa: BLE001 - memory is best-effort; triage proceeds without it
        return []


def _remember(vehicle_id, breach, decision):
    """Write the event back to Memory (best-effort; never blocks the decision)."""
    if not _memory:
        return
    try:
        _memory.create_event(
            memory_id=MEMORY_ID,
            actor_id=vehicle_id,
            session_id=vehicle_id,
            messages=[(json.dumps({"breach": breach, "decision": {
                "severity": decision["severity"], "reason": decision["reason"],
                "eventTime": decision["eventTime"]}}), "ASSISTANT")],
        )
    except Exception:  # noqa: BLE001 - best-effort persistence
        pass


def _result_text(result):
    """Extract the model's text from a Strands AgentResult (fall back to str())."""
    message = getattr(result, "message", None)
    if isinstance(message, dict):
        parts = message.get("content") or []
        text = "".join(p.get("text", "") for p in parts if isinstance(p, dict)).strip()
        if text:
            return text
    return str(result)


@app.entrypoint
def invoke(payload):
    """Triage one breach event; forward only HIGH/CRITICAL to the delivery queue."""
    try:
        return _invoke(payload)
    except Exception:  # noqa: BLE001 - surface the real cause in the runtime logs
        import traceback
        print("ANALYZER_ERROR:\n" + traceback.format_exc(), flush=True)
        raise


def _invoke(payload):
    breach = payload if isinstance(payload, dict) else json.loads(payload)
    vehicle_id = breach.get("vehicleId", "unknown")

    history = _retrieve_history(vehicle_id)
    user_message = triage.build_user_message(breach, history)
    result = call_with_retry(lambda: _agent(user_message))
    decision = triage.parse_decision(_result_text(result), breach)

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
