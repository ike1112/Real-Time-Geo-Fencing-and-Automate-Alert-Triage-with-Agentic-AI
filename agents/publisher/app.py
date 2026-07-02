"""Alert Publisher AgentCore runtime entrypoint (thin adapter, memory disabled).

The message structure (subject + four sections) lives in ``compose`` and the
single-delivery guard in ``idempotency``; both are unit-tested. This module wires
them onto the live services:

    InvokeAgentRuntime(payload=alert)
      -> claim the dedupe key (idempotency) — skip if already published
      -> ask the model (Strands) to draft the four sections, with backoff
      -> render the enforced subject + four-section body
      -> SNS:Publish to the responder topic

Like the analyzer, the live SDK wiring is validated at deploy (verify.md); the
imports here are the runtime contract, not part of the unit-test surface.
"""

import json
import os
import time

import boto3
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from strands import Agent
from strands.models import BedrockModel

import compose
from idempotency import claim, AlreadyPublished
# Reuse the analyzer's throttle backoff (copied into the image at build).
from retry import call_with_retry

MODEL_ID = os.environ["BEDROCK_MODEL_ID"]
ALERTS_TOPIC_ARN = os.environ["ALERTS_TOPIC_ARN"]
IDEMPOTENCY_TABLE = os.environ.get("IDEMPOTENCY_TABLE", "")

DRAFT_PROMPT = """You write concise fleet-incident alerts for an on-call responder.
Given the structured alert JSON, write four short plain-text sections. Respond with
ONLY a JSON object keyed exactly:
{"CURRENT STATUS":str,"WHY THIS ALERT":str,"IMPACT":str,"RECOMMENDED ACTIONS":str}"""

app = BedrockAgentCoreApp()
_sns = boto3.client("sns")
_table = boto3.resource("dynamodb").Table(IDEMPOTENCY_TABLE) if IDEMPOTENCY_TABLE else None
_agent = Agent(model=BedrockModel(model_id=MODEL_ID), system_prompt=DRAFT_PROMPT)


def _draft_sections(alert):
    """Best-effort model-drafted prose; fall back to facts on any parse failure."""
    try:
        result = call_with_retry(lambda: _agent(json.dumps(alert)))
        drafted = json.loads(str(result))
        return drafted if isinstance(drafted, dict) else None
    except Exception:  # noqa: BLE001 - compose() falls back to deterministic facts
        return None


@app.entrypoint
def invoke(payload):
    """Compose and deliver one alert, exactly once per dedupe key."""
    alert = payload if isinstance(payload, dict) else json.loads(payload)

    if _table is not None:
        try:
            claim(_table, compose.dedupe_key(alert), int(time.time()))
        except AlreadyPublished:
            return {"delivered": False, "reason": "duplicate"}

    message = compose.compose(alert, _draft_sections(alert))
    _sns.publish(TopicArn=ALERTS_TOPIC_ARN, Subject=message["subject"][:100], Message=message["body"])
    return {"delivered": True, "dedupeKey": message["dedupeKey"]}


if __name__ == "__main__":
    app.run()
