"""Alert Publisher formatting core (pure, no AWS/LLM imports).

The publisher turns a surviving (HIGH/CRITICAL) alert into the message a human
responder reads: a severity-tagged subject and a body with four fixed sections —
current status, why the alert is raised, impact, recommended actions (H3/AC4). The
model may draft the prose, but the *structure* is enforced here so every delivered
alert has the same four parts and a stable subject, regardless of model wording.

Kept off the model and off AWS so the format is unit-tested directly; ``app.py``
wires it onto Strands + SNS.
"""

# The four required sections, in order. Delivery asserts all four are present.
SECTIONS = ("CURRENT STATUS", "WHY THIS ALERT", "IMPACT", "RECOMMENDED ACTIONS")


def subject(alert):
    """Severity-tagged subject: '[HIGH] Vehicle veh-014: YYC Airside entry'."""
    decision = alert.get("decision", {})
    severity = decision.get("severity", "UNKNOWN")
    vehicle = decision.get("vehicleId") or alert.get("breach", {}).get("vehicleId", "unknown")
    zone = decision.get("zoneName") or decision.get("zoneId") or "a geofence"
    breach_type = decision.get("breachType") or alert.get("breach", {}).get("breachType", "breach")
    return f"[{severity}] Vehicle {vehicle}: {zone} {breach_type}"


def _fmt_location(location):
    if not isinstance(location, dict):
        return "unknown"
    lat, lon = location.get("latitude"), location.get("longitude")
    if lat is None or lon is None:
        return "unknown"
    return f"{lat:.5f}, {lon:.5f}"


def body(alert, drafted_sections=None):
    """Render the four-section body.

    ``drafted_sections`` optionally supplies model-written prose per section (a
    dict keyed by the SECTIONS names); any section the model did not provide falls
    back to a deterministic summary from the facts, so the message is never missing
    a section even if the model output is thin.
    """
    decision = alert.get("decision", {})
    breach = alert.get("breach", {})
    drafted = drafted_sections or {}

    facts = {
        "CURRENT STATUS": (
            f"Vehicle {decision.get('vehicleId', 'unknown')} at "
            f"{_fmt_location(decision.get('location') or breach.get('location'))}; "
            f"{breach.get('durationInStateS', 0)}s in state, "
            f"{breach.get('distanceOutsideM', 0)}m outside the boundary."
        ),
        "WHY THIS ALERT": (
            f"{decision.get('severity', 'UNKNOWN')} {decision.get('zoneKind', '')} "
            f"{decision.get('breachType', 'breach')} at "
            f"{decision.get('zoneName') or decision.get('zoneId', 'a geofence')}. "
            f"{decision.get('reason', '')}"
        ).strip(),
        "IMPACT": decision.get("historicalPattern") or "No prior related history on record.",
        "RECOMMENDED ACTIONS": decision.get("recommendedAction") or "Review and dispatch as appropriate.",
    }

    parts = []
    for name in SECTIONS:
        text = str(drafted.get(name) or facts[name]).strip()
        parts.append(f"{name}:\n{text}")
    return "\n\n".join(parts)


def dedupe_key(alert):
    """The single-delivery identity, carried from the analyzer."""
    return alert.get("dedupeKey", "")


def compose(alert, drafted_sections=None):
    """Full message: subject + four-section body + dedupe key."""
    return {
        "subject": subject(alert),
        "body": body(alert, drafted_sections),
        "dedupeKey": dedupe_key(alert),
    }
