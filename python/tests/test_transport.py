"""Tests for ``wasocket.transport`` (Step 26).

These tests deliberately do NOT use ``pytest-asyncio`` (it is not installed).
Async behaviour is driven by an explicit event loop via ``asyncio.run(...)``
inside plain synchronous test functions.

NO-HANG DISCIPLINE (a prior step hung the machine for hours):
  * EVERY await that could block (recv, connect, reconnect wait, event wait) is
    wrapped in ``asyncio.wait_for`` with a SMALL timeout.
  * The transport AND the fake server are ALWAYS torn down in a ``finally``.
  * Fake servers bind to an EPHEMERAL port (port 0).
  * Reconnect base delays are kept tiny in tests.

Import path: tests insert ``python`` onto ``sys.path`` (matching the
existing suite), so the SDK imports as ``wasocket.transport``.
"""

from __future__ import annotations

import asyncio
import json
import math
import random
import sys
from pathlib import Path


# Ensure the SDK package is importable (python on sys.path).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from wasocket.transport import WSClientTransport, compute_reconnect_delay

from websockets.asyncio.server import serve as ws_serve

# Small global ceiling for any single awaited operation.
OP_TIMEOUT = 5.0


# ===========================================================================
# (a) compute_reconnect_delay — must match the JS reference for a TABLE of
#     (attempt, base, max, jitter, rand) inputs. Cases are ported directly from
#     tests/node/wsClient.test.mjs (computeReconnectDelay coverage).
# ===========================================================================


def _js_reference(attempt, base_ms, max_ms, jitter_ratio, rand):
    """Independent re-implementation of the JS formula (oracle for the port)."""
    if not math.isfinite(attempt) or attempt < 1:
        return 0
    exp = base_ms * (2 ** (attempt - 1))
    delay = min(max_ms, exp)
    jitter = delay * jitter_ratio * (rand() * 2 - 1)
    jittered = max(0, math.floor((delay + jitter) + 0.5))  # JS Math.round
    return min(max_ms, jittered)


def test_compute_reconnect_delay_grows_exponentially_and_caps():
    # Ported from "computeReconnectDelay grows exponentially and caps".
    opts = dict(base_ms=1000, max_ms=60000, jitter_ratio=0, rand=lambda: 0.5)
    expected = {1: 1000, 2: 2000, 3: 4000, 4: 8000, 5: 16000, 6: 32000, 7: 60000, 8: 60000}
    for attempt, want in expected.items():
        assert compute_reconnect_delay(attempt=attempt, **opts) == want, attempt
    # Non-positive / non-finite attempts -> 0.
    assert compute_reconnect_delay(0, 1000, 60000, 0, rand=lambda: 0.5) == 0
    assert compute_reconnect_delay(-1, 1000, 60000, 0, rand=lambda: 0.5) == 0
    assert compute_reconnect_delay(float("nan"), 1000, 60000, 0, rand=lambda: 0.5) == 0


def test_compute_reconnect_delay_bounded_jitter_and_caps_jittered():
    # Ported from "computeReconnectDelay applies bounded jitter and caps the
    # jittered result".
    base = dict(base_ms=1000, max_ms=60000, jitter_ratio=0.2, attempt=1)
    assert compute_reconnect_delay(rand=lambda: 0, **base) == 800
    assert compute_reconnect_delay(rand=lambda: 1, **base) == 1200
    assert compute_reconnect_delay(rand=lambda: 0.5, **base) == 1000

    extreme = compute_reconnect_delay(base_ms=10, max_ms=60000, jitter_ratio=1, attempt=1, rand=lambda: 0)
    assert extreme == 0

    # Jitter must never push the delay above max_ms.
    capped = compute_reconnect_delay(base_ms=40000, max_ms=50000, jitter_ratio=0.5, attempt=1, rand=lambda: 1)
    assert capped == 50000

    # Fuzz: always within [0, max_ms].
    for _ in range(100):
        r = random.random()
        d = compute_reconnect_delay(base_ms=1000, max_ms=60000, jitter_ratio=0.5, attempt=3, rand=lambda: r)
        assert 0 <= d <= 60000, d


def test_compute_reconnect_delay_matches_js_reference_table():
    """Cross-check the port against the independent JS oracle across a table."""
    cases = [
        (1, 1000, 60000, 0.0),
        (2, 1000, 60000, 0.0),
        (3, 1000, 60000, 0.2),
        (5, 500, 30000, 0.5),
        (7, 1000, 60000, 0.2),
        (8, 1000, 60000, 0.2),
        (10, 250, 60000, 0.3),
        (1, 40000, 50000, 0.5),
        (1, 10, 60000, 1.0),
        (0, 1000, 60000, 0.2),
        (-3, 1000, 60000, 0.2),
    ]
    for rand_val in (0.0, 0.25, 0.5, 0.75, 1.0):
        rand = lambda v=rand_val: v
        for attempt, base, mx, jit in cases:
            got = compute_reconnect_delay(attempt, base, mx, jit, rand=rand)
            want = _js_reference(attempt, base, mx, jit, rand)
            assert got == want, (attempt, base, mx, jit, rand_val, got, want)


# ===========================================================================
# Fake server helpers
# ===========================================================================


async def _start_server(handler):
    """Start a fake websockets server on an ephemeral port. Returns (server, url)."""
    server = await ws_serve(handler, "127.0.0.1", 0, ping_interval=None)
    port = list(server.sockets)[0].getsockname()[1]
    return server, f"ws://127.0.0.1:{port}/ws"


async def _stop_server(server):
    server.close()
    try:
        await asyncio.wait_for(server.wait_closed(), timeout=OP_TIMEOUT)
    except Exception:
        pass


def _hello_frame():
    # A plain dict frame is accepted by the transport's _encode (json.dumps).
    return {"type": "hello", "payload": {"folderPath": "/tmp/acct", "protocolVersion": "2.0"}}


# ===========================================================================
# (b) connect sends hello and resolves after hello_ack; frames -> on_frame.
# ===========================================================================


def test_connect_handshake_and_frame_delivery():
    async def scenario():
        got_hello = asyncio.Event()
        server_hello = {}

        async def handler(ws):
            raw = await asyncio.wait_for(ws.recv(), timeout=OP_TIMEOUT)
            server_hello["frame"] = json.loads(raw)
            got_hello.set()
            # Complete the handshake, then push one event frame.
            await ws.send(json.dumps({"type": "hello_ack", "payload": {"folderPath": "/tmp/acct", "waStatus": "open"}}))
            await ws.send(json.dumps({"type": "whatsapp_status", "payload": {"folderPath": "/tmp/acct", "status": "open", "instanceId": "i1"}}))
            try:
                await asyncio.wait_for(ws.wait_closed(), timeout=OP_TIMEOUT)
            except Exception:
                pass

        server, url = await _start_server(handler)
        transport = WSClientTransport(base_ms=10, max_ms=50, jitter_ratio=0)

        frames = []
        statuses = []
        frame_seen = asyncio.Event()

        def on_frame(type_str, parsed):
            frames.append((type_str, parsed))
            frame_seen.set()

        def on_status(status):
            statuses.append(status)

        try:
            await asyncio.wait_for(transport.connect(url, _hello_frame(), on_frame, on_status), timeout=OP_TIMEOUT)
            # connect resolves only after hello_ack.
            assert transport.is_connected() is True
            assert transport.get_attempt() == 0
            # Server received our hello first.
            await asyncio.wait_for(got_hello.wait(), timeout=OP_TIMEOUT)
            assert server_hello["frame"]["type"] == "hello"
            # The pushed frame is delivered to on_frame (decoded).
            await asyncio.wait_for(frame_seen.wait(), timeout=OP_TIMEOUT)
            assert frames[0][0] == "whatsapp_status"
            assert "open" in statuses
            return True
        finally:
            await asyncio.wait_for(transport.close(), timeout=OP_TIMEOUT)
            await _stop_server(server)

    assert asyncio.run(asyncio.wait_for(scenario(), timeout=30)) is True


# ===========================================================================
# (c) accept-then-immediate-close: attempt keeps growing (grace did not reset).
# ===========================================================================


def test_accept_then_close_keeps_growing_attempt():
    async def scenario():
        async def handler(ws):
            # Accept and immediately close — never complete the handshake.
            await ws.close()

        server, url = await _start_server(handler)
        # Tiny backoff so several reconnects happen quickly. The OPEN-grace
        # floor is max(base, 5000)=5000ms, which we never reach, so attempt
        # must keep growing.
        transport = WSClientTransport(base_ms=5, max_ms=40, jitter_ratio=0)

        connect_task = None
        try:
            # connect() never resolves (handshake never completes); run it as a
            # task and observe attempt growth instead.
            connect_task = asyncio.create_task(transport.connect(url, _hello_frame(), lambda *a: None, lambda *a: None))

            observed = []
            deadline = asyncio.get_event_loop().time() + 3.0
            # Poll attempt until it grows to >= 4 (proving repeated reconnects
            # with no grace reset), under a hard ceiling.
            while asyncio.get_event_loop().time() < deadline:
                observed.append(transport.get_attempt())
                if transport.get_attempt() >= 4:
                    break
                await asyncio.sleep(0.02)

            assert transport.get_attempt() >= 4, observed
            # Monotonic non-decreasing growth (never reset to 0 mid-flight).
            assert observed == sorted(observed), observed
            # And the computed delay strictly increases with attempt (until cap).
            d1 = compute_reconnect_delay(1, 5, 40, 0)
            d2 = compute_reconnect_delay(2, 5, 40, 0)
            d3 = compute_reconnect_delay(3, 5, 40, 0)
            assert d1 < d2 < d3, (d1, d2, d3)
            return True
        finally:
            if connect_task is not None:
                connect_task.cancel()
                try:
                    await asyncio.wait_for(connect_task, timeout=OP_TIMEOUT)
                except (asyncio.CancelledError, Exception):
                    pass
            await asyncio.wait_for(transport.close(), timeout=OP_TIMEOUT)
            await _stop_server(server)

    assert asyncio.run(asyncio.wait_for(scenario(), timeout=30)) is True


# ===========================================================================
# (d) send_reliable queues while disconnected; flushes in order; >1000 drops oldest.
# ===========================================================================


def test_send_reliable_drops_oldest_over_1000():
    async def scenario():
        transport = WSClientTransport(base_ms=10, max_ms=50, jitter_ratio=0)
        # Never connected: every send_reliable is queued.
        for i in range(1001):
            await transport.send_reliable({"n": i})
        # deque(maxlen=1000) keeps the newest 1000; the oldest (n=0) is dropped.
        assert transport.get_reliable_queue_size() == 1000
        assert transport._reliable_queue[0]["n"] == 1
        assert transport._reliable_queue[-1]["n"] == 1000
        await transport.close()
        return True

    assert asyncio.run(asyncio.wait_for(scenario(), timeout=OP_TIMEOUT)) is True


def test_cancelled_delivery_wait_removes_queued_action():
    async def scenario():
        transport = WSClientTransport(base_ms=10, max_ms=50, jitter_ratio=0)
        task = asyncio.create_task(transport.send_reliable(
            {"type": "action", "requestId": "r1"},
            wait_for_delivery=True,
            drop_oldest=False,
        ))
        await asyncio.sleep(0)
        assert transport.get_reliable_queue_size() == 1
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        assert transport.get_reliable_queue_size() == 0
        await transport.close()

    asyncio.run(asyncio.wait_for(scenario(), timeout=OP_TIMEOUT))


def test_send_reliable_queues_and_flushes_in_order_on_reconnect():
    async def scenario():
        received = []
        flushed = asyncio.Event()

        async def handler(ws):
            # Handshake: consume hello, ack.
            await asyncio.wait_for(ws.recv(), timeout=OP_TIMEOUT)
            await ws.send(json.dumps({"type": "hello_ack", "payload": {"folderPath": "/tmp/acct", "waStatus": "open"}}))
            try:
                async for raw in ws:
                    received.append(json.loads(raw))
                    if len(received) >= 3:
                        flushed.set()
            except Exception:
                pass

        server, url = await _start_server(handler)
        transport = WSClientTransport(base_ms=10, max_ms=50, jitter_ratio=0)
        try:
            # Queue while disconnected.
            await transport.send_reliable({"type": "r", "n": 0})
            await transport.send_reliable({"type": "r", "n": 1})
            await transport.send_reliable({"type": "r", "n": 2})
            assert transport.get_reliable_queue_size() == 3

            # Connect -> queue flushes in order.
            await asyncio.wait_for(transport.connect(url, _hello_frame(), lambda *a: None, lambda *a: None), timeout=OP_TIMEOUT)
            await asyncio.wait_for(flushed.wait(), timeout=OP_TIMEOUT)

            assert transport.get_reliable_queue_size() == 0
            assert [m["n"] for m in received] == [0, 1, 2], received
            return True
        finally:
            await asyncio.wait_for(transport.close(), timeout=OP_TIMEOUT)
            await _stop_server(server)

    assert asyncio.run(asyncio.wait_for(scenario(), timeout=30)) is True


# ===========================================================================
# (regression) handshake recv timeout: a server that ACCEPTS but NEVER sends
#     hello_ack must NOT hang connect() forever. _open_and_pump wraps the
#     hello_ack recv in asyncio.wait_for(open_timeout); on timeout it returns
#     and the supervisor backs off + retries (attempt grows). Before the fix
#     `await conn.recv()` blocked forever and attempt stayed 0.
# ===========================================================================


def test_connect_does_not_hang_when_no_hello_ack():
    async def scenario():
        async def handler(ws):
            # Accept the connection but NEVER send hello_ack; just hold it open
            # until the client gives up (or our own ceiling fires).
            try:
                await asyncio.wait_for(ws.wait_closed(), timeout=OP_TIMEOUT)
            except Exception:
                pass

        server, url = await _start_server(handler)
        # Small open_timeout so the missing hello_ack recv gives up fast; tiny
        # backoff so reconnects happen quickly.
        transport = WSClientTransport(
            base_ms=5, max_ms=40, jitter_ratio=0, open_timeout=0.15
        )

        statuses = []
        connect_task = None
        try:
            # connect() never resolves (handshake never completes); run it as a
            # task and observe attempt growth instead of awaiting it.
            connect_task = asyncio.create_task(
                transport.connect(
                    url, _hello_frame(), lambda *a: None, lambda s: statuses.append(s)
                )
            )
            observed = []
            deadline = asyncio.get_event_loop().time() + 3.0
            while asyncio.get_event_loop().time() < deadline:
                observed.append(transport.get_attempt())
                if transport.get_attempt() >= 2:
                    break
                await asyncio.sleep(0.02)

            # The handshake recv timed out (returning from _open_and_pump) and
            # the supervisor retried -> attempt grew. Before the fix this would
            # stay 0 forever (recv blocked) and this assertion would time out.
            assert transport.get_attempt() >= 2, observed
            # The handshake never completed, so the transport never reported
            # "open" (that status is emitted only AFTER hello_ack succeeds).
            assert "open" not in statuses, statuses
            return True
        finally:
            if connect_task is not None:
                connect_task.cancel()
                try:
                    await asyncio.wait_for(connect_task, timeout=OP_TIMEOUT)
                except (asyncio.CancelledError, Exception):
                    pass
            await asyncio.wait_for(transport.close(), timeout=OP_TIMEOUT)
            await _stop_server(server)

    assert asyncio.run(asyncio.wait_for(scenario(), timeout=30)) is True
