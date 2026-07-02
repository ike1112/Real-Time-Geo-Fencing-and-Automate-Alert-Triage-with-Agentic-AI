"""Retry-with-exponential-backoff for Bedrock throttling (finding R5).

On-demand Bedrock inference is governed by per-model RPM/TPM quotas and returns
``ThrottlingException`` at peak. Both agent runtimes wrap their model call in
``call_with_retry`` so a throttle backs off and retries instead of failing the
event. The sleeper is injected so the policy is unit-testable with no real waiting;
jitter is derived from the attempt (no wall-clock randomness) to stay deterministic.
"""

# Bedrock signals overload with these error names (botocore ClientError codes).
THROTTLE_ERROR_NAMES = frozenset({
    "ThrottlingException", "TooManyRequestsException",
    "ServiceQuotaExceededException", "ModelTimeoutException",
})


def is_throttle(exc):
    """True if the exception looks like a Bedrock throttle/overload signal."""
    name = type(exc).__name__
    if name in THROTTLE_ERROR_NAMES:
        return True
    # botocore ClientError carries the API error code in response metadata.
    response = getattr(exc, "response", None)
    if isinstance(response, dict):
        code = response.get("Error", {}).get("Code")
        return code in THROTTLE_ERROR_NAMES
    return False


def backoff_seconds(attempt, base=0.5, cap=10.0):
    """Exponential backoff with a small deterministic jitter, capped.

    attempt is 0-based: 0.5s, 1s, 2s, ... up to ``cap``. The jitter (a fixed
    fraction of the delay that varies by attempt) spreads retries without needing
    a random source, so callers stay reproducible.
    """
    delay = min(cap, base * (2 ** attempt))
    jitter = delay * 0.1 * ((attempt % 3) / 2.0)  # 0, 5%, 10%, repeating
    return delay + jitter


def call_with_retry(fn, *, max_attempts=5, sleep=None, is_retryable=is_throttle):
    """Call ``fn`` retrying throttles with exponential backoff.

    Re-raises immediately on a non-throttle error and re-raises the last throttle
    once attempts are exhausted. ``sleep`` defaults to ``time.sleep`` but is
    injectable for tests. Returns whatever ``fn`` returns.
    """
    if sleep is None:
        import time
        sleep = time.sleep

    last = None
    for attempt in range(max_attempts):
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001 - re-raised below unless retryable
            if not is_retryable(exc):
                raise
            last = exc
            if attempt + 1 < max_attempts:
                sleep(backoff_seconds(attempt))
    raise last
