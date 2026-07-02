"""Tuned static-rule baseline (OQ-2) — the bar the AI triage must beat.

Not a strawman "alert on everything": a real dispatcher's heuristic. It suppresses
the obvious GPS-jitter pattern (a poor fix that only just crossed the line, briefly)
and routine dwell-site arrivals/departures; everything else pages. Its weakness —
which the AI is meant to fix — is that it reasons only on the geometry thresholds:
it cannot use corroborating telemetry, so it misses a genuine incident hiding behind
a poor fix and over-pages a poor-fix event that merely lingered.
"""

# Tuned thresholds: a crossing this shallow, this brief, with a fix this poor is
# almost always jitter, not a real incursion.
JITTER_ACCURACY_M = 15.0
JITTER_DISTANCE_M = 25.0
JITTER_DURATION_S = 20.0


def decide(breach):
    """Return ``{"alert": bool, "severity": str}`` for one breach."""
    kind = breach.get("zoneKind")
    location = breach.get("location") or {}
    accuracy = location.get("accuracy") or 0.0
    distance = breach.get("distanceOutsideM") or 0.0
    duration = breach.get("durationInStateS") or 0.0

    # Dwell arrivals/departures are expected at a customer site.
    if kind == "dwell":
        return {"alert": False, "severity": "LOW"}

    looks_like_jitter = (
        accuracy >= JITTER_ACCURACY_M
        and distance < JITTER_DISTANCE_M
        and duration < JITTER_DURATION_S
    )
    if looks_like_jitter:
        return {"alert": False, "severity": "LOW"}

    severity = "CRITICAL" if (kind == "containment" or distance > 200 or duration > 60) else "HIGH"
    return {"alert": True, "severity": severity}
