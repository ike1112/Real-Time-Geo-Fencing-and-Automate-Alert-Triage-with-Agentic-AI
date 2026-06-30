"""Rule-change bridge: DynamoDB Streams -> Kinesis.

The zone store (geo-fences) has change streams enabled. This Lambda turns each
zone insert/modify/remove into a compact rule-change record on the geofence-rules
stream, which the stream processor consumes as a broadcast source so zone edits
take effect without a restart.

The mapping (`to_rule_change`) is pure and has no AWS dependency, so it is
unit-tested directly. boto3 is imported lazily, only when records are actually
forwarded, so the mapping and its tests run without boto3 installed.
"""

import json
import os

RULES_STREAM_NAME = os.environ.get("RULES_STREAM_NAME", "geofence-rules")

_kinesis = None


def _ddb_value(value):
    """Deserialize a single DynamoDB-JSON typed attribute to a plain value.

    Covers the types the zone schema uses (S, N, BOOL, NULL, L, M); numbers
    collapse to int when integral so polygons read as plain coordinates.
    """
    if "S" in value:
        return value["S"]
    if "N" in value:
        number = float(value["N"])
        return int(number) if number.is_integer() else number
    if "BOOL" in value:
        return value["BOOL"]
    if "NULL" in value:
        return None
    if "L" in value:
        return [_ddb_value(item) for item in value["L"]]
    if "M" in value:
        return {key: _ddb_value(item) for key, item in value["M"].items()}
    # Unknown type: surface the raw inner value rather than guessing.
    return next(iter(value.values()))


def _image(raw):
    if not raw:
        return {}
    return {key: _ddb_value(value) for key, value in raw.items()}


def to_rule_change(record):
    """Map one DynamoDB Streams record to a compact rule-change record.

    Returns the dict that goes onto geofence-rules, or None if the record
    carries no usable zone id. REMOVE carries only an old image, so the zone is
    reported inactive.
    """
    op = record["eventName"]  # INSERT | MODIFY | REMOVE
    stream = record["dynamodb"]
    keys = _image(stream.get("Keys"))
    new_image = _image(stream.get("NewImage"))
    old_image = _image(stream.get("OldImage"))
    image = new_image or old_image

    zone_id = keys.get("id") or image.get("id")
    if zone_id is None:
        return None

    properties = image.get("properties") or {}
    return {
        "op": op,
        "id": zone_id,
        "active": False if op == "REMOVE" else bool(image.get("active", False)),
        "kind": properties.get("type"),
        "polygon": image.get("polygon"),
        "properties": properties,
        "updatedAt": image.get("updatedAt"),
    }


def _client():
    global _kinesis
    if _kinesis is None:
        import boto3

        _kinesis = boto3.client("kinesis")
    return _kinesis


def _forward(pending):
    """Put the mapped records; return the sequence numbers that failed.

    `pending` is a list of (sequenceNumber, kinesis-entry). A whole-batch send
    error fails every record; a per-record `ErrorCode` fails just that one.
    """
    entries = [entry for _, entry in pending]
    sequence_numbers = [seq for seq, _ in pending]
    try:
        response = _client().put_records(
            StreamName=RULES_STREAM_NAME, Records=entries
        )
    except Exception:  # send failed for the whole batch -> retry all
        return sequence_numbers

    failed = []
    for seq, result in zip(sequence_numbers, response.get("Records", [])):
        if result.get("ErrorCode"):
            failed.append(seq)
    return failed


def handler(event, _context=None):
    """Forward each zone change to geofence-rules, partition-keyed by zone id.

    Returns the partial-batch-failure response so only records that fail to
    forward are retried, instead of replaying the whole batch on one poison
    record. Unmappable records (no zone id) are skipped, not failed — they are
    not retryable.
    """
    pending = []
    for record in event.get("Records", []):
        change = to_rule_change(record)
        if change is None:
            continue
        sequence_number = record.get("dynamodb", {}).get("SequenceNumber")
        pending.append(
            (
                sequence_number,
                {
                    "Data": json.dumps(change).encode("utf-8"),
                    "PartitionKey": change["id"],
                },
            )
        )

    failed = _forward(pending) if pending else []
    return {
        "batchItemFailures": [
            {"itemIdentifier": seq} for seq in failed if seq is not None
        ]
    }
