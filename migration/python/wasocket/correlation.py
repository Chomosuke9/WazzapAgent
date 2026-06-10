"""WaSocket SDK request-id generation + pending-ack correlation (Step 25).

The SDK awaits each action's ack by ``request_id``. This module owns two
concerns and nothing else:

1. :func:`make_request_id` — generates the ``request_id`` in the exact legacy
   format mandated by CONTRACT.md §3: ``"<tag>-<unix_ms>-<seq6>"`` where the
   ``seq6`` comes from a *module-global*, process-wide monotonic counter
   (``itertools.count(1)``) shared across all sockets in the process. This is a
   verbatim port of ``_make_request_id``/``REQUEST_COUNTER`` in
   ``bridge/messaging/processing.py``.
2. :class:`PendingAcks` — the map of in-flight futures keyed by ``request_id``
   that ``socket.py`` resolves/rejects when an ``action_ack``/``error`` frame
   arrives, with a per-future expiry timer (CONTRACT.md §2/§3).

This module is transport-agnostic: it MUST NOT import ``websockets``, open
sockets, encode/decode frames, or dispatch events. (``asyncio`` is allowed — it
is needed for the futures and the expiry timers.)
"""

from __future__ import annotations

import asyncio
import itertools
import time
from typing import Dict, Optional

from . import errors
from .errors import WaSocketError

# ---------------------------------------------------------------------------
# request_id generation (CONTRACT.md §3)
# ---------------------------------------------------------------------------

# Module-global, process-wide monotonic counter. Shared across *all* sockets in
# the process (per CONTRACT.md §3) — exactly mirrors ``REQUEST_COUNTER`` in
# ``bridge/messaging/processing.py``.
_counter = itertools.count(1)


def make_request_id(tag: str) -> str:
    """Return a ``request_id`` of the form ``"<tag>-<unix_ms>-<seq6>"``.

    Verbatim legacy format (CONTRACT.md §3):

        f"{tag}-{int(time.time() * 1000)}-{next(_counter):06d}"

    ``unix_ms`` is the current Unix time in milliseconds (13 digits) and
    ``seq6`` is a zero-padded 6-digit value from the module-global counter.
    """
    return f"{tag}-{int(time.time() * 1000)}-{next(_counter):06d}"


# ---------------------------------------------------------------------------
# Pending-ack future map (CONTRACT.md §2/§3)
# ---------------------------------------------------------------------------


class PendingAcks:
    """Tracks in-flight action futures keyed by ``request_id``.

    On :meth:`register`, a future is created on the running loop and an expiry
    timer is scheduled. When the matching ``action_ack``/``error`` arrives,
    :meth:`resolve` / :meth:`reject` settle the future and cancel its timer.
    On expiry the future is rejected with a ``timeout`` :class:`WaSocketError`
    and removed from the map. ``resolve``/``reject`` for an unknown or already
    expired/settled ``request_id`` are no-ops (a late ack is ignored, §3).
    """

    def __init__(self) -> None:
        # request_id -> Future awaiting the ack result.
        self._futures: Dict[str, asyncio.Future] = {}
        # request_id -> scheduled timeout handle (TimerHandle).
        self._timers: Dict[str, asyncio.TimerHandle] = {}

    def register(self, request_id: str, *, timeout: float = 30.0) -> asyncio.Future:
        """Create and track a future for ``request_id``; schedule its expiry.

        Returns the awaitable future. After ``timeout`` seconds with no
        resolve/reject, the future is rejected with
        ``errors.TimeoutError(code="timeout")`` and removed from the map.
        """
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        self._futures[request_id] = future
        # Schedule the expiry on the running loop.
        self._timers[request_id] = loop.call_later(
            timeout, self._on_timeout, request_id
        )
        return future

    def resolve(self, request_id: str, result: dict) -> None:
        """Settle ``request_id``'s future with ``result``; no-op if unknown."""
        future = self._pop(request_id)
        if future is None or future.done():
            return
        future.set_result(result)

    def reject(self, request_id: str, error: WaSocketError) -> None:
        """Reject ``request_id``'s future with ``error``; no-op if unknown."""
        future = self._pop(request_id)
        if future is None or future.done():
            return
        future.set_exception(error)

    def reject_all(self, error: WaSocketError) -> None:
        """Reject every outstanding future with ``error`` (used on disconnect)."""
        # Snapshot keys first — _pop mutates the maps.
        for request_id in list(self._futures.keys()):
            future = self._pop(request_id)
            if future is None or future.done():
                continue
            future.set_exception(error)

    # -- internals ----------------------------------------------------------

    def _on_timeout(self, request_id: str) -> None:
        """Expiry callback: reject with a ``timeout`` error and forget it."""
        future = self._futures.pop(request_id, None)
        # The timer just fired, so drop its handle without cancelling.
        self._timers.pop(request_id, None)
        if future is None or future.done():
            return
        future.set_exception(
            errors.TimeoutError(
                "ack wait timed out", code="timeout", request_id=request_id
            )
        )

    def _pop(self, request_id: str) -> Optional[asyncio.Future]:
        """Remove ``request_id`` from the maps, cancelling its timer.

        Returns the future if it was tracked, else ``None`` (no-op caller).
        """
        future = self._futures.pop(request_id, None)
        timer = self._timers.pop(request_id, None)
        if timer is not None:
            timer.cancel()
        return future
