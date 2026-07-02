"""Unit tests for the analyzer bridge: Kinesis decode + partial-batch failures."""

import base64
import json

import analyzer_bridge
from analyzer_bridge import decode_record, handler as run


def _kinesis_record(payload, seq="49590338"):
    data = base64.b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")
    return {"kinesis": {"data": data, "sequenceNumber": seq}}


def test_decode_record_recovers_the_breach_event():
    breach = {"vehicleId": "veh-014", "zoneId": "zone-airport-yyc", "breachType": "entry"}
    assert decode_record(_kinesis_record(breach)) == breach


def test_handler_invokes_once_per_record_and_reports_no_failures(monkeypatch):
    invoked = []
    monkeypatch.setattr(analyzer_bridge, "_invoke", lambda breach: invoked.append(breach["vehicleId"]))
    event = {"Records": [_kinesis_record({"vehicleId": "veh-1"}, "s1"),
                        _kinesis_record({"vehicleId": "veh-2"}, "s2")]}
    result = run(event)
    assert invoked == ["veh-1", "veh-2"]
    assert result == {"batchItemFailures": []}


def test_handler_reports_only_the_failing_record(monkeypatch):
    def flaky(breach):
        if breach["vehicleId"] == "veh-2":
            raise RuntimeError("throttled")

    monkeypatch.setattr(analyzer_bridge, "_invoke", flaky)
    event = {"Records": [_kinesis_record({"vehicleId": "veh-1"}, "s1"),
                        _kinesis_record({"vehicleId": "veh-2"}, "s2")]}
    result = run(event)
    assert result == {"batchItemFailures": [{"itemIdentifier": "s2"}]}
