"""Unit tests for the Bedrock throttle backoff (finding R5)."""

import pytest

from retry import call_with_retry, backoff_seconds, is_throttle


class Throttle(Exception):
    """Stand-in with the botocore ClientError shape (Error.Code)."""

    def __init__(self, code="ThrottlingException"):
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


class ThrottlingException(Exception):
    """Recognized by class name alone (no response metadata)."""


class Boom(Exception):
    pass


def test_retries_throttle_then_succeeds():
    slept = []
    calls = {"n": 0}

    def fn():
        calls["n"] += 1
        if calls["n"] < 3:
            raise Throttle()
        return "ok"

    assert call_with_retry(fn, sleep=slept.append) == "ok"
    assert calls["n"] == 3
    assert len(slept) == 2                    # backed off before each retry
    assert slept == sorted(slept)             # non-decreasing (exponential)


def test_gives_up_after_max_attempts_and_reraises_last_throttle():
    slept = []
    with pytest.raises(Throttle):
        call_with_retry(lambda: (_ for _ in ()).throw(Throttle()),
                        max_attempts=4, sleep=slept.append)
    assert len(slept) == 3                     # 4 tries -> 3 backoffs


def test_non_throttle_error_is_not_retried():
    calls = {"n": 0}

    def fn():
        calls["n"] += 1
        raise Boom()

    with pytest.raises(Boom):
        call_with_retry(fn, sleep=lambda _s: None)
    assert calls["n"] == 1                      # failed fast, no retry


def test_is_throttle_recognizes_named_and_coded_forms():
    assert is_throttle(ThrottlingException())                   # by class name
    assert is_throttle(Throttle("TooManyRequestsException"))    # by response code
    assert not is_throttle(Boom())


def test_backoff_is_exponential_and_capped():
    assert backoff_seconds(0) == pytest.approx(0.5, abs=0.1)
    assert backoff_seconds(1) >= 1.0
    assert backoff_seconds(2) >= 2.0
    assert backoff_seconds(20) <= 10.0 * 1.1   # capped (+ at most 10% jitter)
