"""Tests for ``wasocket.socket`` (Step 27) — the public ``WaSocket`` surface,
exercised against ``stub_node_server.py``.

These tests deliberately do NOT use ``pytest-asyncio`` (it is not installed).
Async behaviour is driven by an explicit event loop via ``asyncio.run(...)``
inside plain synchronous test functions.

NO-HANG DISCIPLINE (a prior step hung the machine for hours):
  * EVERY await that could block is wrapped in ``asyncio.wait_for`` with a SMALL
    timeout, and each ``asyncio.run`` scenario is itself wrapped in ``wait_for``.
  * The socket is ALWAYS ``disconnect()``-ed and the stub server ALWAYS
    ``stop()``-ped in a ``finally``.
  * The stub binds an EPHEMERAL port; reconnect base delays are kept tiny and
    the SDK heartbeat interval is set far beyond the test horizon.

Import path: tests insert ``migration/python`` onto ``sys.path`` (matching the
existing suite), so the SDK imports as ``wasocket`` and the stub as
``stub_node_server``.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

# Ensure the SDK package + the tests dir are importable.
_TESTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(_TESTS_DIR.parent))  # migration/python -> `wasocket`
sys.path.insert(0, str(_TESTS_DIR))         # tests dir -> `stub_node_server`

from wasocket import (  # noqa: E402
    WaSocket,
    WhatsAppMessage,
    NotFoundError,
    make_wa_socket,
)
from stub_node_server import StubNodeServer, BAD_DELETE_ID  # noqa: E402

# Small global ceiling for any single awaited operation.
OP_TIMEOUT = 5.0
# Hard ceiling for an entire scenario (defense-in-depth against hangs).
SCENARIO_TIMEOUT = 30.0

FOLDER = "/tmp/wa-tenant-step27"
CHAT = "12345@g.us"


def _make_socket() -> WaSocket:
    """Build a WaSocket with tiny reconnect base + a heartbeat interval well
    beyond the test horizon, and a short ack timeout (acks arrive instantly)."""
    return make_wa_socket(
        FOLDER,
        base_ms=10,
        max_ms=50,
        jitter_ratio=0,
        heartbeat_interval_ms=60000,
        ack_timeout=OP_TIMEOUT,
    )


def _run(scenario) -> object:
    """Run an async scenario under a hard wall-clock ceiling."""
    return asyncio.run(asyncio.wait_for(scenario(), timeout=SCENARIO_TIMEOUT))


# ===========================================================================
# connect() fires "ready" after hello_ack
# ===========================================================================


def test_connect_fires_ready():
    async def scenario():
        server = StubNodeServer(FOLDER)
        port = await server.start()
        sock = _make_socket()

        ready_hits = []

        @sock.on("ready")
        async def _on_ready(_payload):
            ready_hits.append(True)

        try:
            await asyncio.wait_for(
                sock.connect(f"ws://127.0.0.1:{port}/ws"), timeout=OP_TIMEOUT
            )
            # "ready" fires during connect (after hello_ack), before it returns.
            assert ready_hits == [True], ready_hits
            assert sock.is_connected is True
            assert sock.folder_path == FOLDER
            return True
        finally:
            await asyncio.wait_for(sock.disconnect(), timeout=OP_TIMEOUT)
            await server.stop()

    assert _run(scenario) is True


# ===========================================================================
# send_message awaits the ack and returns the result dict with sent[...]
# ===========================================================================


def test_send_message_returns_result_with_sent():
    async def scenario():
        server = StubNodeServer(FOLDER)
        port = await server.start()
        sock = _make_socket()
        try:
            await asyncio.wait_for(
                sock.connect(f"ws://127.0.0.1:{port}/ws"), timeout=OP_TIMEOUT
            )
            result = await asyncio.wait_for(
                sock.send_message(CHAT, "hi"), timeout=OP_TIMEOUT
            )
            assert isinstance(result, dict), result
            assert "sent" in result, result
            assert result["sent"][0]["contextMsgId"] == "000123", result
            # The pending future was settled and removed.
            assert sock._pending._futures == {}, sock._pending._futures
            return True
        finally:
            await asyncio.wait_for(sock.disconnect(), timeout=OP_TIMEOUT)
            await server.stop()

    assert _run(scenario) is True


# ===========================================================================
# delete_message with the sentinel bad id raises NotFoundError
# ===========================================================================


def test_delete_message_bad_id_raises_not_found():
    async def scenario():
        server = StubNodeServer(FOLDER)
        port = await server.start()
        sock = _make_socket()
        try:
            await asyncio.wait_for(
                sock.connect(f"ws://127.0.0.1:{port}/ws"), timeout=OP_TIMEOUT
            )
            raised = None
            try:
                await asyncio.wait_for(
                    sock.delete_message(CHAT, BAD_DELETE_ID), timeout=OP_TIMEOUT
                )
            except NotFoundError as err:
                raised = err
            assert raised is not None, "expected NotFoundError"
            assert raised.code == "not_found", raised.code
            # Future cleaned up after the rejection.
            assert sock._pending._futures == {}, sock._pending._futures
            return True
        finally:
            await asyncio.wait_for(sock.disconnect(), timeout=OP_TIMEOUT)
            await server.stop()

    assert _run(scenario) is True


# ===========================================================================
# an emitted incoming_message invokes @sock.on("message") with a WhatsAppMessage
# whose folder_path matches
# ===========================================================================


def test_incoming_message_invokes_handler():
    async def scenario():
        server = StubNodeServer(FOLDER)
        port = await server.start()
        sock = _make_socket()

        got = asyncio.Event()
        seen = {}

        @sock.on("message")
        def _on_message(msg):  # sync handler is supported too
            seen["msg"] = msg
            got.set()

        try:
            await asyncio.wait_for(
                sock.connect(f"ws://127.0.0.1:{port}/ws"), timeout=OP_TIMEOUT
            )
            await server.wait_connected(timeout=OP_TIMEOUT)
            await server.push_incoming_message(
                {
                    "folderPath": FOLDER,
                    "instanceId": "i1",
                    "chatId": CHAT,
                    "chatName": "Group",
                    "chatType": "group",
                    "messageId": "wamid-1",
                    "senderId": "98765@s.whatsapp.net",
                    "senderRef": "u8k2d1",
                    "senderName": "Alice",
                    "senderIsAdmin": False,
                    "senderIsSuperAdmin": False,
                    "isGroup": True,
                    "botIsAdmin": True,
                    "botIsSuperAdmin": False,
                    "fromMe": False,
                    "contextOnly": False,
                    "triggerLlm1": False,
                    "timestampMs": 1738560000000,
                    "messageType": "conversation",
                    "text": "Hello world",
                    "contextMsgId": "000125",
                }
            )
            await asyncio.wait_for(got.wait(), timeout=OP_TIMEOUT)
            msg = seen["msg"]
            assert isinstance(msg, WhatsAppMessage), type(msg)
            assert msg.folder_path == FOLDER, msg.folder_path
            assert msg.text == "Hello world", msg.text
            assert msg.context_msg_id == "000125", msg.context_msg_id
            return True
        finally:
            await asyncio.wait_for(sock.disconnect(), timeout=OP_TIMEOUT)
            await server.stop()

    assert _run(scenario) is True


# ===========================================================================
# an emitted clear_history invokes @sock.on("clear_history")
# ===========================================================================


def test_clear_history_invokes_handler():
    async def scenario():
        server = StubNodeServer(FOLDER)
        port = await server.start()
        sock = _make_socket()

        got = asyncio.Event()
        seen = {}

        @sock.on("clear_history")
        async def _on_clear(payload):
            seen["payload"] = payload
            got.set()

        try:
            await asyncio.wait_for(
                sock.connect(f"ws://127.0.0.1:{port}/ws"), timeout=OP_TIMEOUT
            )
            await server.wait_connected(timeout=OP_TIMEOUT)
            await server.push_clear_history("global")
            await asyncio.wait_for(got.wait(), timeout=OP_TIMEOUT)
            payload = seen["payload"]
            assert isinstance(payload, dict), payload
            assert payload["type"] == "clear_history", payload
            assert payload["chatId"] == "global", payload
            assert payload["folderPath"] == FOLDER, payload
            return True
        finally:
            await asyncio.wait_for(sock.disconnect(), timeout=OP_TIMEOUT)
            await server.stop()

    assert _run(scenario) is True


# ===========================================================================
# mark_read returns None and registers NO pending future (fire-and-forget)
# ===========================================================================


def test_mark_read_fire_and_forget():
    async def scenario():
        server = StubNodeServer(FOLDER)
        port = await server.start()
        sock = _make_socket()
        try:
            await asyncio.wait_for(
                sock.connect(f"ws://127.0.0.1:{port}/ws"), timeout=OP_TIMEOUT
            )
            result = await asyncio.wait_for(
                sock.mark_read(CHAT, "wamid-1"), timeout=OP_TIMEOUT
            )
            assert result is None, result
            # No future was ever registered for a fire-and-forget action.
            assert sock._pending._futures == {}, sock._pending._futures
            # send_presence is the other fire-and-forget method.
            result2 = await asyncio.wait_for(
                sock.send_presence(CHAT, "composing"), timeout=OP_TIMEOUT
            )
            assert result2 is None, result2
            assert sock._pending._futures == {}, sock._pending._futures
            return True
        finally:
            await asyncio.wait_for(sock.disconnect(), timeout=OP_TIMEOUT)
            await server.stop()

    assert _run(scenario) is True
