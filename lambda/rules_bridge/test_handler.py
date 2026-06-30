"""Unit tests for the rule-change mapping (pure, no AWS)."""

from handler import to_rule_change


def _stream_record(event_name, *, keys=None, new=None, old=None):
    body = {}
    if keys is not None:
        body["Keys"] = keys
    if new is not None:
        body["NewImage"] = new
    if old is not None:
        body["OldImage"] = old
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
