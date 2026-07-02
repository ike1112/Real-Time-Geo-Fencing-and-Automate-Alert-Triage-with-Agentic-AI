"""Unit tests for the publisher bridge: SQS decode + partial-batch failures."""

import json

import publisher_bridge
from publisher_bridge import decode_record, handler as run


def _sqs_record(payload, message_id="m1"):
    return {"body": json.dumps(payload), "messageId": message_id}


def test_decode_record_recovers_the_alert():
    alert = {"dedupeKey": "veh-014|z|entry|1", "decision": {"severity": "HIGH"}}
    assert decode_record(_sqs_record(alert)) == alert


def test_handler_invokes_once_per_message(monkeypatch):
    invoked = []
    monkeypatch.setattr(publisher_bridge, "_invoke", lambda alert: invoked.append(alert["dedupeKey"]))
    event = {"Records": [_sqs_record({"dedupeKey": "a"}, "m1"),
                        _sqs_record({"dedupeKey": "b"}, "m2")]}
    assert run(event) == {"batchItemFailures": []}
    assert invoked == ["a", "b"]


def test_handler_reports_only_the_failing_message(monkeypatch):
    def flaky(alert):
        if alert["dedupeKey"] == "b":
            raise RuntimeError("invoke failed")

    monkeypatch.setattr(publisher_bridge, "_invoke", flaky)
    event = {"Records": [_sqs_record({"dedupeKey": "a"}, "m1"),
                        _sqs_record({"dedupeKey": "b"}, "m2")]}
    assert run(event) == {"batchItemFailures": [{"itemIdentifier": "m2"}]}
