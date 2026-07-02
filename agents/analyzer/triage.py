"""Alert Analyzer decision core (pure, no AWS/LLM imports).

The analyzer judges each factual breach event (from 002) into a decision and a
severity, consulting per-vehicle history. The *judgment* is made by the model
against the rubric in ``SYSTEM_PROMPT``; this module holds everything around that
call that must be deterministic and unit-testable:

- the rubric prompt and the per-event user message (with history, label never shown);
- parsing + validating the model's structured output into a normalized decision;
- the suppression gate (only HIGH/CRITICAL continue) — the H1 mechanism, in one place;
- the dedupe key and the enriched payload handed to the delivery stage.

Keeping this off the model keeps the gate auditable and the tests free of a live
Bedrock call. ``app.py`` is the thin AgentCore/Strands adapter that wires the model
and Memory onto these functions.
"""

import json

ALERT = "ALERT"
NO_ALERT = "NO_ALERT"
DECISIONS = (ALERT, NO_ALERT)

LOW = "LOW"
MEDIUM = "MEDIUM"
HIGH = "HIGH"
CRITICAL = "CRITICAL"
# Ascending order so thresholds are comparable.
SEVERITIES = (LOW, MEDIUM, HIGH, CRITICAL)

# Only these severities pass the suppression gate to delivery (FR3). Kept as data
# so the policy is one obvious, changeable line rather than scattered conditionals.
DELIVERABLE_SEVERITIES = frozenset({HIGH, CRITICAL})

SYSTEM_PROMPT = """You are the alert-triage analyst for a fleet geofencing system.
Each input is a FACTUAL geofence breach event — the detector has already decided a
boundary was crossed; it assigns no severity or reason. Your job is to decide
whether this breach deserves a human responder's attention right now, and how
severe it is, then explain why.

Zone semantics:
- exclusion (no-go): a vehicle ENTERING is the violation (e.g. airport airside).
- containment (keep-in): a vehicle LEAVING is the violation (e.g. a depot yard —
  leaving after hours is a theft signal).
- dwell: arrivals and departures at an expected customer site; usually routine.

Judge from the facts, not a fixed rule. Signals that a breach is likely a FALSE
POSITIVE to suppress: poor GPS accuracy (large accuracy metres) paired with a small
distanceOutsideM and a short durationInStateS; a brief boundary nick at a dwell
site. Signals that a breach is GENUINE and high/critical: a sustained containment
exit or exclusion entry, a large distance outside, a sustained duration; and
corroborating vehicle telemetry (implausible speed, high engine temperature, low
fuel, a door open with the ignition on).

Use the vehicle's HISTORY when provided: a repeat offense or an escalating trend
raises severity; a known-benign recurring pattern at the same place lowers it.

Respond with ONLY a JSON object, no prose, with exactly these fields:
{"decision":"ALERT|NO_ALERT","severity":"LOW|MEDIUM|HIGH|CRITICAL","reason":string,
"confidence":number 0..1,"recommendedAction":string,"historicalPattern":string}
Set decision=ALERT only when severity is HIGH or CRITICAL."""


def build_user_message(breach, history=None):
    """Render one breach (+ optional history) as the model's user turn.

    ``history`` is a list of prior decision/summary records for this vehicle from
    Memory. The ground-truth eval label is never part of a breach here, so it
    cannot leak into the prompt.
    """
    lines = ["Breach event:", json.dumps(breach, indent=2, sort_keys=True)]
    if history:
        lines.append("")
        lines.append(f"Vehicle history ({len(history)} prior record(s), newest last):")
        for record in history:
            lines.append(json.dumps(record, sort_keys=True))
    else:
        lines.append("")
        lines.append("Vehicle history: none on record.")
    return "\n".join(lines)


def _clamp_confidence(value):
    try:
        confidence = float(value)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(1.0, confidence))


class InvalidDecision(Exception):
    """The model output could not be parsed into a valid decision."""


def parse_decision(raw, breach):
    """Parse + normalize the model's structured output into a decision dict.

    Accepts a JSON string or an already-parsed dict. Enforces the enums, clamps
    confidence, carries vehicleId/location/zone context from the breach (so
    downstream never has to re-derive them), and forces decision/severity to agree
    with the gate (ALERT iff HIGH/CRITICAL) so a model that violates that rule
    cannot leak a low-severity ALERT past the gate. Raises ``InvalidDecision`` for
    output that is not usable at all.
    """
    if isinstance(raw, (str, bytes, bytearray)):
        try:
            data = json.loads(raw)
        except (ValueError, TypeError) as exc:
            raise InvalidDecision(f"analyzer output is not JSON: {exc}")
    else:
        data = raw
    if not isinstance(data, dict):
        raise InvalidDecision("analyzer output is not a JSON object")

    severity = str(data.get("severity", "")).upper()
    if severity not in SEVERITIES:
        raise InvalidDecision(f"unknown severity: {data.get('severity')!r}")

    # The gate is severity-driven; make decision agree with it rather than trust a
    # possibly-inconsistent model field.
    decision = ALERT if severity in DELIVERABLE_SEVERITIES else NO_ALERT

    return {
        "decision": decision,
        "severity": severity,
        "reason": str(data.get("reason", "")).strip(),
        "confidence": _clamp_confidence(data.get("confidence")),
        "recommendedAction": str(data.get("recommendedAction", "")).strip(),
        "historicalPattern": str(data.get("historicalPattern", "")).strip(),
        "vehicleId": breach.get("vehicleId"),
        "zoneId": breach.get("zoneId"),
        "zoneName": breach.get("zoneName"),
        "zoneKind": breach.get("zoneKind"),
        "breachType": breach.get("breachType"),
        "location": breach.get("location"),
        "eventTime": breach.get("timestamp"),
    }


def should_deliver(decision):
    """The suppression gate: only HIGH/CRITICAL alerts continue to delivery."""
    return decision.get("decision") == ALERT and decision.get("severity") in DELIVERABLE_SEVERITIES


def dedupe_key(breach):
    """Stable identity of a breach for single-delivery: vehicle|zone|type|eventTime."""
    return "|".join(
        str(breach.get(field, ""))
        for field in ("vehicleId", "zoneId", "breachType", "timestamp")
    )


def to_delivery_message(breach, decision):
    """The payload the analyzer writes to SQS for the publisher (gate already passed)."""
    return {
        "dedupeKey": dedupe_key(breach),
        "decision": decision,
        "breach": breach,
    }
