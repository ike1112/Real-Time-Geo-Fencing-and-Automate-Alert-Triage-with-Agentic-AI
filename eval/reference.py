"""Deterministic reference triager — an OFFLINE stand-in, not the product.

The deployed Alert Analyzer (Bedrock, agents/analyzer) is the real system-under-test;
its H1 numbers come from the live run (verify.md), which needs model access and a
deploy. So the machinery can be exercised and a *measurable delta over the baseline*
demonstrated with no cloud, this module encodes the rubric's judgment as code: it
discounts distance when the GPS fix is poor and, unlike the baseline, uses
corroborating telemetry (a door open while moving, implausible speed/temperature,
near-empty fuel) to keep a genuine incident that hides behind a poor fix.

It exists to validate the eval harness end to end offline, NOT to stand in for the
model in production. Treat any delta it shows as a property of the harness, not the
H1 result.
"""


def _corroborating(vehicle):
    """Telemetry that corroborates a genuine incident regardless of geometry."""
    speed = vehicle.get("speed") or 0.0
    engine_temp = vehicle.get("engineTemperature") or 0.0
    fuel = vehicle.get("fuelLevel")
    door_open_moving = bool(vehicle.get("doorOpen") and vehicle.get("ignition"))
    return (
        door_open_moving
        or speed > 140.0
        or engine_temp > 120.0
        or (fuel is not None and fuel < 0.05)
    )


def decide(breach):
    """Return ``{"alert": bool, "severity": str}`` for one breach."""
    kind = breach.get("zoneKind")
    location = breach.get("location") or {}
    accuracy = location.get("accuracy") or 0.0
    distance = breach.get("distanceOutsideM") or 0.0
    duration = breach.get("durationInStateS") or 0.0
    corroborating = _corroborating(breach.get("vehicle") or {})

    # Distance only counts when it clearly exceeds the GPS error; an exclusion entry
    # sits at distance 0 (inside), so trust a sustained entry on a good fix instead.
    confident_outside = distance > 2 * max(accuracy, 1.0)
    sustained = duration >= 30.0
    trusted_entry = kind == "exclusion" and distance == 0.0 and accuracy <= 8.0

    # Routine dwell traffic, unless the telemetry says otherwise.
    if kind == "dwell" and not corroborating:
        return {"alert": False, "severity": "LOW"}

    genuine = corroborating or (sustained and (confident_outside or trusted_entry))
    if not genuine:
        return {"alert": False, "severity": "LOW"}

    severity = "CRITICAL" if (corroborating or kind == "containment" or distance >= 100) else "HIGH"
    return {"alert": True, "severity": severity}
