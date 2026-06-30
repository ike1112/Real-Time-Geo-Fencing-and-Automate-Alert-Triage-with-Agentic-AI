"""Unit tests for the rule-change mapping (pure) and the partial-batch contract."""

import handler as handler_module
from handler import to_rule_change, handler


def _stream_record(event_name, *, keys=None, new=None, old=None, seq=None):
    body = {}
    if keys is not None:
        body["Keys"] = keys
    if new is not None:
        body["NewImage"] = new
    if old is not None:
        body["OldImage"] = old
    if seq is not None:
        body["SequenceNumber"] = seq
    return {"eventName": event_name, "dynamodb": body}


_DOWNTOWN_IMAGE = {
    "id": {"S": "zone-downtown-restricted"},
    "active": {"BOOL": True},
    "polygon": {
        "L": [
            {"L": [{"N": "51.050"}, {"N": "-114.085"}]},
            {"L": [{"N": "51.050"}, {"N": "-114.060"}]},
            {"L": [{"N": "51.040"}, {"N": "-114.060"}]},
            {"L": [{"N": "51.050"}, {"N": "-114.085"}]},
        ]
    },
    "properties": {
        "M": {
            "type": {"S": "exclusion"},
            "alertLevel": {"S": "high"},
            "maxSpeed": {"N": "50"},
        }
    },
    "updatedAt": {"N": "1782000000000"},
}


def test_insert_maps_to_active_rule_change():
    record = _stream_record(
        "INSERT", keys={"id": {"S": "zone-downtown-restricted"}}, new=_DOWNTOWN_IMAGE
    )
    change = to_rule_change(record)
    assert change == {
        "op": "INSERT",
        "id": "zone-downtown-restricted",
        "active": True,
        "kind": "exclusion",
        "polygon": [
            [51.050, -114.085],
            [51.050, -114.060],
            [51.040, -114.060],
            [51.050, -114.085],
        ],
        "properties": {"type": "exclusion", "alertLevel": "high", "maxSpeed": 50},
        "updatedAt": 1782000000000,
    }


def test_modify_deactivation_carries_active_false():
    new = dict(_DOWNTOWN_IMAGE, active={"BOOL": False})
    record = _stream_record(
        "MODIFY",
        keys={"id": {"S": "zone-downtown-restricted"}},
        new=new,
        old=_DOWNTOWN_IMAGE,
    )
    change = to_rule_change(record)
    assert change["op"] == "MODIFY"
    assert change["active"] is False
    assert change["kind"] == "exclusion"


def test_remove_uses_old_image_and_reports_inactive():
    record = _stream_record(
        "REMOVE", keys={"id": {"S": "zone-downtown-restricted"}}, old=_DOWNTOWN_IMAGE
    )
    change = to_rule_change(record)
    assert change["op"] == "REMOVE"
    assert change["id"] == "zone-downtown-restricted"
    assert change["active"] is False
    # polygon still surfaced from the old image so the processor can drop the zone
    assert change["polygon"][0] == [51.050, -114.085]


def test_record_without_id_is_skipped():
    record = _stream_record("INSERT", keys={}, new={"active": {"BOOL": True}})
    assert to_rule_change(record) is None


# --- partial-batch failure contract ---------------------------------------


class _FakeKinesis:
    """Stand-in Kinesis client; per-record results or a whole-call raise."""

    def __init__(self, *, error_codes=None, raises=False):
        self.error_codes = error_codes or []
        self.raises = raises

    def put_records(self, StreamName, Records):  # noqa: N803 (boto3 kwarg name)
        if self.raises:
            raise RuntimeError("stream unavailable")
        results = []
        for index in range(len(Records)):
            code = self.error_codes[index] if index < len(self.error_codes) else None
            results.append({"ErrorCode": code} if code else {"SequenceNumber": "ok"})
        return {"Records": results, "FailedRecordCount": len(self.error_codes)}


def _event(*records):
    return {"Records": list(records)}


def _insert(zone_id, seq):
    return _stream_record(
        "INSERT", keys={"id": {"S": zone_id}}, new=_DOWNTOWN_IMAGE, seq=seq
    )


def test_all_forwarded_reports_no_failures(monkeypatch):
    monkeypatch.setattr(handler_module, "_client", lambda: _FakeKinesis())
    result = handler(_event(_insert("z1", "seq-1"), _insert("z2", "seq-2")))
    assert result == {"batchItemFailures": []}


def test_per_record_error_reports_only_that_sequence(monkeypatch):
    # second record errors, first succeeds
    monkeypatch.setattr(
        handler_module,
        "_client",
        lambda: _FakeKinesis(error_codes=[None, "ProvisionedThroughputExceededException"]),
    )
    result = handler(_event(_insert("z1", "seq-1"), _insert("z2", "seq-2")))
    assert result == {"batchItemFailures": [{"itemIdentifier": "seq-2"}]}


def test_whole_batch_send_error_reports_all(monkeypatch):
    monkeypatch.setattr(handler_module, "_client", lambda: _FakeKinesis(raises=True))
    result = handler(_event(_insert("z1", "seq-1"), _insert("z2", "seq-2")))
    assert result == {
        "batchItemFailures": [{"itemIdentifier": "seq-1"}, {"itemIdentifier": "seq-2"}]
    }


def test_unmappable_record_is_skipped_not_failed(monkeypatch):
    monkeypatch.setattr(handler_module, "_client", lambda: _FakeKinesis())
    # one good record + one with no id; the no-id record must not appear as a failure
    bad = _stream_record("INSERT", keys={}, new={"active": {"BOOL": True}}, seq="seq-bad")
    result = handler(_event(_insert("z1", "seq-1"), bad))
    assert result == {"batchItemFailures": []}
