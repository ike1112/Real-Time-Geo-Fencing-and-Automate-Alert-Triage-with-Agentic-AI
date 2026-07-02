"""Unit tests for idempotent publish: the same dedupe key sends exactly once (AC5)."""

import pytest

from idempotency import claim, AlreadyPublished, is_conditional_failure


class ConditionalCheckFailedException(Exception):
    pass


class FakeTable:
    """Minimal DynamoDB table honoring attribute_not_exists(dedupeKey)."""

    def __init__(self):
        self.items = {}

    def put_item(self, Item, ConditionExpression=None):
        key = Item["dedupeKey"]
        if ConditionExpression == "attribute_not_exists(dedupeKey)" and key in self.items:
            raise ConditionalCheckFailedException()
        self.items[key] = Item


def test_first_claim_succeeds_second_is_rejected():
    table = FakeTable()
    claim(table, "veh-014|zone|entry|1", now_epoch_s=1000)      # first: wins
    with pytest.raises(AlreadyPublished):
        claim(table, "veh-014|zone|entry|1", now_epoch_s=1001)  # duplicate: rejected


def test_different_keys_each_claim_once():
    table = FakeTable()
    claim(table, "key-a", now_epoch_s=1000)
    claim(table, "key-b", now_epoch_s=1000)                     # distinct: no conflict
    assert set(table.items) == {"key-a", "key-b"}


def test_claim_sets_a_ttl():
    table = FakeTable()
    claim(table, "key-a", now_epoch_s=1000, ttl_days=1)
    assert table.items["key-a"]["expiresAt"] == 1000 + 86400


def test_non_conditional_errors_propagate():
    class Boom(Exception):
        pass

    class BrokenTable:
        def put_item(self, **_):
            raise Boom()

    with pytest.raises(Boom):
        claim(BrokenTable(), "key", now_epoch_s=1000)


def test_is_conditional_failure_detects_coded_form():
    class Coded(Exception):
        response = {"Error": {"Code": "ConditionalCheckFailedException"}}

    assert is_conditional_failure(Coded())
    assert not is_conditional_failure(ValueError())
