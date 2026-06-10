"""Tests for ``wasocket.correlation`` (Step 25).

These tests deliberately do NOT use ``pytest-asyncio`` (it is not installed).
Async behaviour is exercised by driving an event loop explicitly via
``asyncio.run(...)`` inside plain synchronous test functions. Every awaited
future has a bounded timeout so the suite can never hang.

Import path: tests insert ``migration/python`` onto ``sys.path`` (matching the
existing test suite), so the SDK imports as ``wasocket.correlation``.
"""

from __future__ import annotations

import asyncio
import re
import sys
from pathlib import Path

import pytest

# Ensure the SDK package is importable (migration/python on sys.path).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from wasocket import errors
from wasocket.correlation import PendingAcks, make_request_id

REQUEST_ID_RE = re.compile(r"^send-\d{13}-\d{6}$")


def _seq6(request_id: str) -> int:
    """Extract the trailing 6-digit sequence as an int."""
    return int(request_id.rsplit("-", 1)[1])


def test_make_request_id_format_and_monotonic_seq() -> None:
    first = make_request_id("send")
    second = make_request_id("send")

    assert REQUEST_ID_RE.match(first), first
    assert REQUEST_ID_RE.match(second), second
    # The module-global counter is strictly increasing across calls.
    assert _seq6(second) > _seq6(first)


def test_register_then_resolve_resolves_with_result() -> None:
    async def scenario() -> dict:
        pending = PendingAcks()
        fut = pending.register("req-1", timeout=5.0)
        result = {"ok": True, "detail": "sent"}
        pending.resolve("req-1", result)
        return await asyncio.wait_for(fut, timeout=1.0)

    got = asyncio.run(scenario())
    assert got == {"ok": True, "detail": "sent"}


def test_register_timeout_rejects_with_timeout_error() -> None:
    async def scenario() -> None:
        pending = PendingAcks()
        fut = pending.register("req-timeout", timeout=0.05)
        # No resolve/reject — the expiry timer must reject the future.
        await asyncio.wait_for(fut, timeout=1.0)

    with pytest.raises(errors.TimeoutError) as exc_info:
        asyncio.run(scenario())
    assert exc_info.value.code == "timeout"


def test_resolve_unknown_id_is_noop() -> None:
    async def scenario() -> None:
        pending = PendingAcks()
        # No registration for this id — must not raise.
        pending.resolve("never-registered", {"ok": True})
        pending.reject("also-unknown", errors.SendFailedError("nope"))

    # Should complete without raising.
    asyncio.run(scenario())


def test_reject_all_rejects_outstanding_futures() -> None:
    async def scenario() -> list:
        pending = PendingAcks()
        f1 = pending.register("a", timeout=5.0)
        f2 = pending.register("b", timeout=5.0)
        pending.reject_all(errors.SendFailedError("disconnected", code="send_failed"))

        outcomes = []
        for fut in (f1, f2):
            try:
                await asyncio.wait_for(fut, timeout=1.0)
                outcomes.append(None)
            except errors.WaSocketError as exc:
                outcomes.append(exc.code)
        return outcomes

    outcomes = asyncio.run(scenario())
    assert outcomes == ["send_failed", "send_failed"]


def test_resolve_cancels_timeout_no_late_rejection() -> None:
    """Resolving cancels the expiry; the future stays resolved afterwards."""

    async def scenario() -> dict:
        pending = PendingAcks()
        fut = pending.register("req-x", timeout=0.05)
        pending.resolve("req-x", {"ok": True})
        result = await asyncio.wait_for(fut, timeout=1.0)
        # Wait past the original expiry window; the cancelled timer must not
        # try to settle an already-done future (would raise InvalidStateError).
        await asyncio.sleep(0.1)
        return result

    assert asyncio.run(scenario()) == {"ok": True}
