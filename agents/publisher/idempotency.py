"""Idempotent-publish guard (finding R4, the mechanism behind single-delivery AC5).

The end-to-end pipeline is at-least-once: partial-batch reporting and stream/SQS
redelivery lower but do not eliminate reprocessing, so the same breach can reach
the publisher more than once. Before publishing, the publisher *claims* the
breach's dedupe key with a DynamoDB conditional write (put if-not-exists). The
first claim wins and sends the email; a second claim for the same key fails the
condition and is skipped, so a redelivered breach never produces a second alert.

The DynamoDB call is injected as a ``table`` with ``put_item``; the conditional
logic and the conflict translation are pure and unit-tested with a fake table.
"""


class AlreadyPublished(Exception):
    """The dedupe key was already claimed — this delivery is a duplicate."""


def is_conditional_failure(exc):
    """True if ``exc`` is a DynamoDB conditional-check failure (claim lost)."""
    if type(exc).__name__ == "ConditionalCheckFailedException":
        return True
    response = getattr(exc, "response", None)
    if isinstance(response, dict):
        return response.get("Error", {}).get("Code") == "ConditionalCheckFailedException"
    return False


def claim(table, dedupe_key, now_epoch_s, ttl_days=30):
    """Claim ``dedupe_key`` exactly once; raise ``AlreadyPublished`` if already taken.

    Writes an item keyed by the dedupe key, guarded by ``attribute_not_exists`` so
    only the first writer succeeds. A TTL lets old keys expire so the table does
    not grow without bound.
    """
    expires_at = int(now_epoch_s) + ttl_days * 24 * 3600
    try:
        table.put_item(
            Item={"dedupeKey": dedupe_key, "expiresAt": expires_at},
            ConditionExpression="attribute_not_exists(dedupeKey)",
        )
    except Exception as exc:  # noqa: BLE001 - only conditional failures are swallowed
        if is_conditional_failure(exc):
            raise AlreadyPublished(dedupe_key)
        raise
