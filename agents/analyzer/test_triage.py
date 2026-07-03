"""Unit tests for the analyzer decision core: gate, parsing, dedupe, message shape."""

import json

import pytest

import triage
from triage import (
    ALERT, NO_ALERT, LOW, MEDIUM, HIGH, CRITICAL,
    build_user_message, parse_decision, should_deliver, dedupe_key,
    to_delivery_message, InvalidDecision, DELIVERABLE_SEVERITIES,
)


def _breach(**over):
    breach = {
        "vehicleId": "veh-014",
        "zoneId": "zone-airport-yyc",
        "zoneName": "YYC Airside",
        "zoneKind": "exclusion",
        "breachType": "entry",
        "timestamp": 1782458400000,
        "location": {"latitude": 51.13, "longitude": -114.01, "accuracy": 3.2},
        "distanceOutsideM": 0.0,
        "durationInStateS": 40,
        "vehicle": {"speed": 46.5, "ignition": True},
    }
    breach.update(over)
    return breach


# --- Suppression gate (FR3, AC3): only HIGH/CRITICAL pass. ---

@pytest.mark.parametrize("severity,expected", [
    (LOW, False), (MEDIUM, False), (HIGH, True), (CRITICAL, True),
])
def test_gate_passes_only_high_and_critical(severity, expected):
    decision = parse_decision({"severity": severity, "reason": "x"}, _breach())
    assert should_deliver(decision) is expected


def test_gate_policy_is_exactly_high_and_critical():
    assert DELIVERABLE_SEVERITIES == frozenset({HIGH, CRITICAL})


# --- Structured-output parsing + normalization. ---

def test_parse_forces_decision_to_agree_with_severity_gate():
    # A model that says ALERT at LOW severity must not leak past the gate.
    d = parse_decision({"decision": ALERT, "severity": LOW, "reason": "r"}, _breach())
    assert d["decision"] == NO_ALERT and should_deliver(d) is False
    # ...and NO_ALERT at CRITICAL is corrected to ALERT so a real one is not dropped.
    d2 = parse_decision({"decision": NO_ALERT, "severity": CRITICAL, "reason": "r"}, _breach())
    assert d2["decision"] == ALERT and should_deliver(d2) is True


def test_parse_accepts_json_string_and_carries_breach_context():
    raw = json.dumps({"severity": "high", "reason": "sustained exit",
                      "confidence": 0.9, "recommendedAction": "dispatch"})
    d = parse_decision(raw, _breach())
    assert d["severity"] == HIGH                       # upper-cased
    assert d["vehicleId"] == "veh-014"
    assert d["zoneId"] == "zone-airport-yyc"
    assert d["eventTime"] == 1782458400000
    assert d["location"]["latitude"] == 51.13


def test_parse_clamps_confidence_and_defaults_missing_fields():
    d = parse_decision({"severity": HIGH, "confidence": 5}, _breach())
    assert d["confidence"] == 1.0
    d2 = parse_decision({"severity": HIGH, "confidence": "bogus"}, _breach())
    assert d2["confidence"] == 0.0
    assert d2["recommendedAction"] == ""


@pytest.mark.parametrize("bad", ["not json", "[1,2,3]", json.dumps({"severity": "SEVERE"})])
def test_parse_rejects_unusable_output(bad):
    with pytest.raises(InvalidDecision):
        parse_decision(bad, _breach())


def test_parse_recovers_json_wrapped_in_prose_or_a_fence():
    wrapped = 'Here is my decision:\n```json\n{"severity": "high", "reason": "sustained exit"}\n```\nDone.'
    d = parse_decision(wrapped, _breach())
    assert d["severity"] == HIGH and should_deliver(d) is True


# --- Dedupe + delivery payload. ---

def test_dedupe_key_is_stable_and_specific():
    assert dedupe_key(_breach()) == "veh-014|zone-airport-yyc|entry|1782458400000"
    # A different crossing time is a different key.
    assert dedupe_key(_breach(timestamp=1782458401000)) != dedupe_key(_breach())


def test_to_delivery_message_bundles_key_decision_and_breach():
    breach = _breach()
    decision = parse_decision({"severity": CRITICAL, "reason": "airside entry"}, breach)
    msg = to_delivery_message(breach, decision)
    assert msg["dedupeKey"] == dedupe_key(breach)
    assert msg["decision"]["severity"] == CRITICAL
    assert msg["breach"]["vehicleId"] == "veh-014"


# --- Prompt building: history is surfaced; no-history path is explicit. ---

def test_user_message_includes_history():
    history = [{"severity": HIGH, "zoneId": "zone-airport-yyc"}]
    msg = build_user_message(_breach(), history)
    assert "prior record" in msg and "zone-airport-yyc" in msg


def test_user_message_handles_no_history():
    assert "none on record" in build_user_message(_breach())
