"""Unit tests for the publisher formatter: subject, four sections, dedupe (AC4)."""

import compose
from compose import subject, body, compose as compose_message, SECTIONS


def _alert(**over):
    alert = {
        "dedupeKey": "veh-014|zone-airport-yyc|entry|1782458400000",
        "decision": {
            "severity": "HIGH",
            "vehicleId": "veh-014",
            "zoneId": "zone-airport-yyc",
            "zoneName": "YYC Airside",
            "zoneKind": "exclusion",
            "breachType": "entry",
            "reason": "Sustained airside entry with corroborating speed.",
            "recommendedAction": "Dispatch security to intercept.",
            "historicalPattern": "Second airside entry this week.",
            "location": {"latitude": 51.13, "longitude": -114.01},
        },
        "breach": {"vehicleId": "veh-014", "breachType": "entry",
                  "durationInStateS": 40, "distanceOutsideM": 0.0,
                  "location": {"latitude": 51.13, "longitude": -114.01}},
    }
    alert.update(over)
    return alert


def test_subject_is_severity_tagged():
    assert subject(_alert()) == "[HIGH] Vehicle veh-014: YYC Airside entry"


def test_body_has_all_four_sections_in_order():
    text = body(_alert())
    assert [s for s in SECTIONS if f"{s}:" in text] == list(SECTIONS)
    # order preserved
    positions = [text.index(f"{s}:") for s in SECTIONS]
    assert positions == sorted(positions)


def test_body_carries_reason_action_and_history():
    text = body(_alert())
    assert "Sustained airside entry" in text
    assert "Dispatch security" in text
    assert "Second airside entry this week." in text
    assert "51.13000, -114.01000" in text          # coordinates present, not the WHOLE message


def test_body_falls_back_when_a_section_is_thin():
    thin = _alert(decision={**_alert()["decision"], "recommendedAction": "", "historicalPattern": ""})
    text = body(thin)
    assert "Review and dispatch as appropriate." in text
    assert "No prior related history on record." in text


def test_body_prefers_model_drafted_prose_when_supplied():
    drafted = {"RECOMMENDED ACTIONS": "Call the depot supervisor immediately."}
    text = body(_alert(), drafted)
    assert "Call the depot supervisor immediately." in text
    assert "Dispatch security" not in text          # model draft overrides the fact fallback


def test_compose_bundles_subject_body_and_dedupe():
    msg = compose_message(_alert())
    assert msg["subject"].startswith("[HIGH]")
    assert all(f"{s}:" in msg["body"] for s in SECTIONS)
    assert msg["dedupeKey"] == "veh-014|zone-airport-yyc|entry|1782458400000"


def test_alert_is_not_raw_coordinates_only():
    # AC4/FR4: a delivered alert is human-readable, not just a lat/lon dump.
    text = body(_alert())
    assert len(text) > 100 and "WHY THIS ALERT" in text
