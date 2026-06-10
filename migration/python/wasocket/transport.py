# wasocket/transport.py
#
# WSClientTransport — the resilient WebSocket *client* layer of the WaSocket
# SDK. This is a 1:1 Python port of ``migration/node/wsClient.ts`` (the Node
# gateway's ``LLMWebSocket``): exponential backoff with symmetric jitter, the
# canonical ``isAlive`` heartbeat (check-then-ping / terminate-on-missed-pong),
# the accept-then-kick grace timer, a bounded reliable queue, the
# ``hello``/``hello_ack`` handshake, and graceful close.
#
# Scope (Step 26):
#   - ``compute_reconnect_delay`` — EXACT port of ``computeReconnectDelay``
#     (same formula + clamp to ``max_ms``; injectable ``rand``).
#   - ``class WSClientTransport`` — opens the socket, performs the
#     ``hello``/``hello_ack`` handshake (CONTRACT.md §1.1), pumps raw *decoded*
#     frames to an ``on_frame`` callback, exposes best-effort ``send`` and a
#     bounded reliable queue (CONTRACT.md §1.6), reconnects with backoff +
#     OPEN-grace ``attempt`` reset, runs the heartbeat, and closes gracefully.
#
# The transport EMITS raw decoded frames (``protocol.decode`` results) to
# ``on_frame``; it does NOT interpret them.
#
# Intentionally NOT here (later steps):
#   - No action methods (send_message/react/etc.).
#   - No ``request_id`` generation (Step 25 / correlation.py; CONTRACT.md §3).
#   - No event dispatch / ``on()`` decorator / public ``WaSocket`` API (Step 27).
#   - No agent logic.

from __future__ import annotations

import asyncio
import collections
import json
import logging
import math
import random
from typing import Any, Awaitable, Callable, Optional, Union

import websockets
from websockets.asyncio.client import ClientConnection, connect as ws_connect
from websockets.protocol import State

from . import protocol

logger = logging.getLogger("wasocket.transport")

# A frame the transport transmits: a protocol dataclass, a ready-made dict, or a
# pre-serialised JSON string. ``_encode`` normalises all three to a wire string.
Frame = Union[Any, dict, str]

# Callback types. Both may be sync or async; the transport awaits coroutines.
OnFrame = Callable[[str, object], Union[None, Awaitable[None]]]
OnStatus = Callable[[str], Union[None, Awaitable[None]]]


def _js_round(value: float) -> int:
    """Round half *up* like JavaScript ``Math.round`` (``floor(x + 0.5)``).

    Python's built-in :func:`round` uses banker's rounding, which would diverge
    from ``wsClient.ts`` on exact ``.5`` boundaries. ``Math.round`` is defined as
    ``floor(x + 0.5)``; we mirror that to keep the port byte-for-byte faithful.
    """
    return math.floor(value + 0.5)


def compute_reconnect_delay(
    attempt: float,
    base_ms: float,
    max_ms: float,
    jitter_ratio: float,
    rand: Callable[[], float] = random.random,
) -> int:
    """Pure port of ``wsClient.ts`` ``computeReconnectDelay``.

    Exponential backoff with symmetric jitter for a given (1-indexed)
    ``attempt``. Intended for ``attempt >= 1`` (attempt 0 is the initial connect
    and is not scheduled). For ``attempt <= 0`` (or non-finite) this returns 0.

    The jittered delay is clamped to ``max_ms`` so a large ``jitter_ratio``
    cannot push the returned delay above the configured cap.

    Mirrors exactly::

        const exp = baseMs * Math.pow(2, attempt - 1);
        const delay = Math.min(maxMs, exp);
        const jitter = delay * jitterRatio * (rand() * 2 - 1);
        const jittered = Math.max(0, Math.round(delay + jitter));
        return Math.min(maxMs, jittered);

    Returns the delay in ms (rounded, floored to 0, capped at ``max_ms``).
    """
    if not math.isfinite(attempt) or attempt < 1:
        return 0
    exp = base_ms * math.pow(2, attempt - 1)
    delay = min(max_ms, exp)
    jitter = delay * jitter_ratio * (rand() * 2 - 1)
    jittered = max(0, _js_round(delay + jitter))
    return int(min(max_ms, jittered))


class WSClientTransport:
    """Resilient WebSocket client (Python port of ``LLMWebSocket``).

    Lifecycle::

        t = WSClientTransport()
        await t.connect(node_url, hello_frame, on_frame, on_status)
        await t.send(frame)            # best-effort, dropped if not OPEN
        await t.send_reliable(frame)   # queued if not OPEN, flushed on reconnect
        await t.close()

    ``connect`` resolves once the first ``hello``/``hello_ack`` handshake
    completes. A background supervisor keeps the connection alive: on any drop
    it increments ``attempt`` and waits ``compute_reconnect_delay`` before
    re-opening. ``attempt`` is reset to 0 ONLY after the socket has stayed OPEN
    for the grace window (``max(base_ms, 5000)`` ms), so an accept-then-kick
    flap keeps the backoff growing — exactly like ``wsClient.ts``.
    """

    #: Maximum number of queued reliable messages before dropping oldest.
    MAX_RELIABLE_QUEUE = 1000

    #: Hard floor for the OPEN-grace window (ms) — mirrors ``Math.max(..., 5000)``.
    STABLE_RESET_FLOOR_MS = 5000

    def __init__(
        self,
        *,
        base_ms: float = 5000,
        max_ms: float = 60000,
        jitter_ratio: float = 0.2,
        heartbeat_interval_ms: float = 20000,
        headers: Optional[dict] = None,
        open_timeout: float = 10.0,
        max_size: Optional[int] = 20 * 1024 * 1024,
        rand: Callable[[], float] = random.random,
    ) -> None:
        # Reconnect/backoff tuning (defaults mirror config.ts WS_* defaults).
        self._base_ms = base_ms
        self._max_ms = max_ms
        self._jitter_ratio = jitter_ratio
        self._heartbeat_interval_ms = heartbeat_interval_ms
        self._headers = headers or {}
        self._open_timeout = open_timeout
        self._max_size = max_size
        self._rand = rand

        # Connection state.
        self._connection: Optional[ClientConnection] = None
        self.attempt: int = 0
        self.is_alive: bool = False

        # Reliable queue — bounded, drop-oldest (deque(maxlen) drops the oldest
        # on overflow, identical to wsClient's push-then-shift).
        self._reliable_queue: "collections.deque[Frame]" = collections.deque(
            maxlen=self.MAX_RELIABLE_QUEUE
        )

        # Background tasks / signals.
        self._supervisor_task: Optional[asyncio.Task] = None
        self._heartbeat_task: Optional[asyncio.Task] = None
        self._stable_reset_task: Optional[asyncio.Task] = None
        self._ready_event: Optional[asyncio.Event] = None
        self._closed: bool = False

        # Connection params (captured by connect()).
        self._node_url: Optional[str] = None
        self._hello_frame: Optional[Frame] = None
        self._on_frame: Optional[OnFrame] = None
        self._on_status: Optional[OnStatus] = None

    # ------------------------------------------------------------------ #
    # Public API
    # ------------------------------------------------------------------ #

    async def connect(
        self,
        node_url: str,
        hello_frame: Frame,
        on_frame: OnFrame,
        on_status: Optional[OnStatus] = None,
    ) -> None:
        """Open the socket, perform the handshake, and start the supervisor.

        Resolves once the first ``hello_ack`` has been received (or earlier if
        :meth:`close` is called). Subsequent reconnects are handled in the
        background supervisor task and do NOT re-block this call.
        """
        self._node_url = node_url
        self._hello_frame = hello_frame
        self._on_frame = on_frame
        self._on_status = on_status
        self._closed = False
        self.attempt = 0
        self._ready_event = asyncio.Event()
        self._supervisor_task = asyncio.create_task(self._supervise())
        # Block until the first handshake completes (or close() releases us).
        await self._ready_event.wait()

    async def send(self, frame: Frame) -> None:
        """Best-effort send — dropped silently if the socket is not OPEN.

        Mirrors ``wsClient.send``: used for transient frames (the next burst
        re-sends newer state anyway).
        """
        if not self.is_connected():
            logger.debug("ws not ready, drop message")
            return
        await self._send_raw(frame)

    async def send_reliable(self, frame: Frame) -> None:
        """Send if OPEN, otherwise queue (bounded 1000, drop-oldest).

        Mirrors ``wsClient.sendReliable``: state-sync frames that must not be
        lost. Queued frames are flushed in order on the next successful connect.
        """
        if self.is_connected():
            await self._send_raw(frame)
            return
        if len(self._reliable_queue) >= self.MAX_RELIABLE_QUEUE:
            logger.warning(
                "reliable ws queue overflow; oldest message dropped (size=%d)",
                len(self._reliable_queue),
            )
        # deque(maxlen=...) drops the oldest automatically on append.
        self._reliable_queue.append(frame)
        logger.debug("ws not ready, queued reliable message (size=%d)", len(self._reliable_queue))

    async def flush_reliable(self) -> None:
        """Drain the reliable queue in order if the socket is OPEN."""
        if not self.is_connected():
            return
        if not self._reliable_queue:
            return
        queued = list(self._reliable_queue)
        self._reliable_queue.clear()
        for frame in queued:
            await self._send_raw(frame)
        logger.info("flushed queued reliable ws messages (count=%d)", len(queued))

    async def close(self) -> None:
        """Stop the supervisor/timers, best-effort flush, and close the socket.

        Mirrors ``wsClient.close``: cancels the reconnect/heartbeat/grace timers,
        flushes the reliable queue if still OPEN, drops whatever remains, and
        closes the underlying socket. Idempotent.
        """
        self._closed = True
        self._clear_heartbeat()

        conn = self._connection
        # Best-effort: flush queued reliable frames while the socket is OPEN.
        if conn is not None and conn.state == State.OPEN and self._reliable_queue:
            await self.flush_reliable()
        if self._reliable_queue:
            logger.info("ws close dropping queued reliable messages (dropped=%d)", len(self._reliable_queue))
            self._reliable_queue.clear()

        # Stop the supervisor (and therefore any in-flight reconnect/pump).
        if self._supervisor_task is not None:
            self._supervisor_task.cancel()
            try:
                await self._supervisor_task
            except asyncio.CancelledError:
                pass
            except Exception as err:  # pragma: no cover - defensive
                logger.warning("supervisor task ended with error on close: %r", err)
            self._supervisor_task = None

        # Close the socket itself (bounded so close() can never hang).
        if conn is not None:
            try:
                await asyncio.wait_for(conn.close(), timeout=1.0)
            except Exception as err:
                logger.warning("ws close failed: %r", err)
            self._connection = None

        self.is_alive = False
        # Release any caller still blocked in connect().
        if self._ready_event is not None:
            self._ready_event.set()

    # ------------------------------------------------------------------ #
    # Introspection (mirrors wsClient getters)
    # ------------------------------------------------------------------ #

    def is_connected(self) -> bool:
        conn = self._connection
        return conn is not None and conn.state == State.OPEN

    def get_attempt(self) -> int:
        return self.attempt

    def get_reliable_queue_size(self) -> int:
        return len(self._reliable_queue)

    # ------------------------------------------------------------------ #
    # Supervisor / reconnect loop (ports connect + scheduleReconnect)
    # ------------------------------------------------------------------ #

    async def _supervise(self) -> None:
        """Background loop: connect, pump until close, then back off and retry.

        ``attempt`` is incremented here (mirrors ``scheduleReconnect``); it is
        reset to 0 only by the OPEN-grace timer armed after a successful
        handshake, so accept-then-kick flaps keep the backoff growing.
        """
        try:
            while not self._closed:
                await self._open_and_pump()
                if self._closed:
                    break
                # scheduleReconnect: bump attempt, then wait the backoff.
                self.attempt += 1
                delay_ms = compute_reconnect_delay(
                    self.attempt,
                    self._base_ms,
                    self._max_ms,
                    self._jitter_ratio,
                    rand=self._rand,
                )
                logger.info("scheduling ws reconnect (attempt=%d, delayMs=%d)", self.attempt, delay_ms)
                await asyncio.sleep(delay_ms / 1000.0)
        except asyncio.CancelledError:
            raise

    async def _open_and_pump(self) -> None:
        """Open one connection, handshake, then pump frames until it closes.

        On success arms the heartbeat + OPEN-grace timer, flushes the reliable
        queue, signals readiness, and forwards every decoded frame to
        ``on_frame``. The ``finally`` clears the heartbeat/grace timers (so a
        close before the grace window leaves ``attempt`` intact).
        """
        conn: Optional[ClientConnection] = None
        opened = False
        try:
            try:
                conn = await ws_connect(
                    self._node_url,
                    additional_headers=self._headers,
                    open_timeout=self._open_timeout,
                    max_size=self._max_size,
                    # Disable the library keepalive: we run our own isAlive
                    # heartbeat to mirror wsClient.ts exactly. We still auto-pong
                    # the server's pings (ping_interval=20 in main.py).
                    ping_interval=None,
                )
            except Exception as err:
                logger.warning("ws connect failed: %r", err)
                return

            self._connection = conn
            self.is_alive = True

            # --- handshake: send hello, await hello_ack (CONTRACT.md §1.1) ---
            await conn.send(self._encode(self._hello_frame))
            raw = await conn.recv()
            type_str, _parsed = protocol.decode(raw if isinstance(raw, str) else raw.decode())
            if type_str != "hello_ack":
                logger.warning("expected hello_ack, got %r; closing", type_str)
                return

            # Handshake complete — mirror wsClient 'open' handler ordering.
            opened = True
            logger.info("LLM websocket connected")
            self._start_heartbeat(conn)
            self._arm_stable_reset()
            await self.flush_reliable()
            await self._emit_status("open")
            if self._ready_event is not None:
                self._ready_event.set()

            # --- frame pump: emit raw decoded frames; do NOT interpret ---
            async for raw in conn:
                if isinstance(raw, (bytes, bytearray)):
                    raw = raw.decode()
                try:
                    frame = protocol.decode(raw)
                except Exception as err:
                    logger.warning("failed parsing ws message: %r", err)
                    continue
                await self._emit_frame(frame)
        except asyncio.CancelledError:
            raise
        except websockets.ConnectionClosed:
            # Normal disconnect path — supervisor will reconnect.
            pass
        except Exception as err:  # pragma: no cover - defensive
            logger.warning("ws connection error: %r", err)
        finally:
            # Mirror _clearHeartbeat (cancels heartbeat AND the grace timer, so a
            # close before the grace window does NOT reset attempt).
            self._clear_heartbeat()
            self._connection = None
            self.is_alive = False
            if opened:
                await self._emit_status("closed")

    # ------------------------------------------------------------------ #
    # Heartbeat (ports _startHeartbeat / _clearHeartbeat + stableResetTimer)
    # ------------------------------------------------------------------ #

    def _start_heartbeat(self, conn: ClientConnection) -> None:
        self._clear_heartbeat()
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop(conn))

    async def _heartbeat_loop(self, conn: ClientConnection) -> None:
        """Canonical ``isAlive`` check-then-ping loop.

        Every interval: if the socket missed the previous pong, terminate it
        (which triggers the reconnect path); otherwise clear the flag and ping.
        A pong re-marks the socket alive via :meth:`_make_pong_cb`.
        """
        interval = self._heartbeat_interval_ms / 1000.0
        try:
            while True:
                await asyncio.sleep(interval)
                if self._connection is not conn or conn.state != State.OPEN:
                    return
                if self.is_alive is False:
                    logger.warning(
                        "ws heartbeat missed pong, terminating socket (intervalMs=%s)",
                        self._heartbeat_interval_ms,
                    )
                    try:
                        # No ws.terminate() equivalent; closing causes the pump's
                        # recv to raise ConnectionClosed -> normal reconnect path.
                        await conn.close(code=1011, reason="heartbeat timeout")
                    except Exception as err:
                        logger.warning("ws terminate failed: %r", err)
                    return
                self.is_alive = False
                try:
                    pong_waiter = await conn.ping()
                    pong_waiter.add_done_callback(self._make_pong_cb(conn))
                except Exception as err:
                    logger.warning("ws ping failed: %r", err)
        except asyncio.CancelledError:
            raise

    def _make_pong_cb(self, conn: ClientConnection) -> Callable[[asyncio.Future], None]:
        """Build a pong callback that re-marks the matching socket alive."""

        def _cb(fut: asyncio.Future) -> None:
            if fut.cancelled():
                return
            if fut.exception() is not None:
                return
            if self._connection is conn:
                self.is_alive = True

        return _cb

    def _arm_stable_reset(self) -> None:
        """Arm the OPEN-grace timer that resets ``attempt`` to 0.

        Mirrors the ``stableResetTimer`` armed in wsClient's 'open' handler:
        only if the socket stays OPEN for ``max(base_ms, 5000)`` ms is
        ``attempt`` reset, so a quick close leaves the backoff growing.
        """
        self._clear_stable_reset()
        stable_after_ms = max(self._base_ms, self.STABLE_RESET_FLOOR_MS)
        self._stable_reset_task = asyncio.create_task(self._stable_reset(stable_after_ms / 1000.0))

    async def _stable_reset(self, delay_s: float) -> None:
        try:
            await asyncio.sleep(delay_s)
            self.attempt = 0
            self._stable_reset_task = None
        except asyncio.CancelledError:
            raise

    def _clear_stable_reset(self) -> None:
        if self._stable_reset_task is not None:
            self._stable_reset_task.cancel()
            self._stable_reset_task = None

    def _clear_heartbeat(self) -> None:
        """Cancel the heartbeat AND the grace timer (mirrors _clearHeartbeat)."""
        if self._heartbeat_task is not None:
            self._heartbeat_task.cancel()
            self._heartbeat_task = None
        self._clear_stable_reset()

    # ------------------------------------------------------------------ #
    # Low-level send + callback dispatch
    # ------------------------------------------------------------------ #

    async def _send_raw(self, frame: Frame) -> None:
        conn = self._connection
        if conn is None:
            return
        try:
            await conn.send(self._encode(frame))
        except Exception as err:
            logger.error("failed sending ws message: %r", err)

    @staticmethod
    def _encode(frame: Frame) -> str:
        """Normalise a frame (dataclass | dict | str) to a JSON wire string."""
        if isinstance(frame, str):
            return frame
        if isinstance(frame, dict):
            return json.dumps(frame)
        return protocol.encode(frame)

    async def _emit_frame(self, frame: tuple[str, object]) -> None:
        if self._on_frame is None:
            return
        type_str, parsed = frame
        result = self._on_frame(type_str, parsed)
        if asyncio.iscoroutine(result):
            await result

    async def _emit_status(self, status: str) -> None:
        if self._on_status is None:
            return
        result = self._on_status(status)
        if asyncio.iscoroutine(result):
            await result


__all__ = ["compute_reconnect_delay", "WSClientTransport"]
