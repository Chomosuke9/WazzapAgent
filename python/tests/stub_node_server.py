"""stub_node_server.py — a minimal asyncio websockets server that stands in for
the real Step 20 Node ``wsServer`` during WaSocket SDK integration tests.

It implements just enough of CONTRACT.md §1 to exercise :class:`wasocket.WaSocket`:

  * Handshake: accept a ``hello`` frame -> reply ``hello_ack`` (echoing
    ``folderPath``, ``waStatus="open"``) — CONTRACT §1.1.
  * ``send_message`` action -> reply ``action_ack`` (ok, with a ``result.sent``)
    *and* a legacy ``send_ack`` — CONTRACT §1.2/§1.3.
  * ``delete_message`` carrying the sentinel bad id -> reply an ``error``
    ``not_found`` — CONTRACT §1.3/§2. Any other ``delete_message`` -> ``action_ack`` ok.
  * ``mark_read`` / ``send_presence`` -> NO ack (CONTRACT §1.2).
  * Every other action carrying a ``requestId`` -> a generic ok ``action_ack``.
  * Server-initiated pushes: ``incoming_message`` (§1.4) and ``clear_history`` (§1.5).

NO-HANG DISCIPLINE: ephemeral port (port 0), library keepalive disabled
(``ping_interval=None`` so the SDK's own heartbeat governs), and ``stop()``
closes the live client + the server under a bounded ``wait_for``.
"""

from __future__ import annotations

import asyncio
import json

from websockets.asyncio.server import serve as ws_serve

# Default sentinel contextMsgId that triggers a ``not_found`` error on delete.
BAD_DELETE_ID = "<bad>"


class StubNodeServer:
    """A canned-response WS server bound to an ephemeral localhost port."""

    def __init__(self, folder_path: str, *, bad_delete_id: str = BAD_DELETE_ID) -> None:
        self.folder_path = folder_path
        self.bad_delete_id = bad_delete_id
        self._server = None
        self._ws = None  # the most recently connected client connection
        self._connected = asyncio.Event()
        # Records of frames the server received, for test assertions.
        self.received: list = []

    # ----------------------------- lifecycle ----------------------------- #

    async def start(self) -> int:
        """Start the server on an ephemeral port; return the bound port."""
        self._server = await ws_serve(
            self._handler, "127.0.0.1", 0, ping_interval=None
        )
        sock = list(self._server.sockets)[0]
        return sock.getsockname()[1]

    async def stop(self) -> None:
        """Close the live client (if any) and the server. Bounded; never hangs."""
        ws = self._ws
        if ws is not None:
            try:
                await asyncio.wait_for(ws.close(), timeout=2.0)
            except Exception:
                pass
            self._ws = None
        if self._server is not None:
            self._server.close()
            try:
                await asyncio.wait_for(self._server.wait_closed(), timeout=5.0)
            except Exception:
                pass
            self._server = None

    async def wait_connected(self, timeout: float = 5.0) -> None:
        """Block until a client has connected (and the server bound its ws)."""
        await asyncio.wait_for(self._connected.wait(), timeout=timeout)

    # --------------------------- server pushes --------------------------- #

    async def push_incoming_message(self, payload: dict) -> None:
        """Push an ``incoming_message`` event to the connected client (§1.4)."""
        assert self._ws is not None, "no client connected"
        await self._ws.send(json.dumps({"type": "incoming_message", "payload": payload}))

    async def push_clear_history(self, chat_id: str) -> None:
        """Push a ``clear_history`` control event to the client (§1.5)."""
        assert self._ws is not None, "no client connected"
        await self._ws.send(
            json.dumps(
                {
                    "type": "clear_history",
                    "folderPath": self.folder_path,
                    "chatId": chat_id,
                }
            )
        )

    # ------------------------------ handler ------------------------------ #

    async def _handler(self, ws) -> None:
        self._ws = ws
        self._connected.set()
        try:
            async for raw in ws:
                try:
                    obj = json.loads(raw)
                except Exception:
                    continue
                self.received.append(obj)
                await self._on_frame(ws, obj)
        except Exception:
            # Client closed / reset — normal during teardown.
            pass

    async def _on_frame(self, ws, obj: dict) -> None:
        type_str = obj.get("type")
        payload = obj.get("payload") or {}

        if type_str == "hello":
            await ws.send(
                json.dumps(
                    {
                        "type": "hello_ack",
                        "payload": {
                            "folderPath": payload.get("folderPath", self.folder_path),
                            "waStatus": "open",
                        },
                    }
                )
            )
            return

        if type_str == "send_message":
            request_id = payload.get("requestId")
            await ws.send(
                json.dumps(
                    {
                        "type": "action_ack",
                        "payload": {
                            "requestId": request_id,
                            "action": "send_message",
                            "ok": True,
                            "detail": "sent",
                            "code": None,
                            "result": {
                                "sent": [
                                    {
                                        "kind": "text",
                                        "contextMsgId": "000123",
                                        "messageId": "wamid-abc",
                                    }
                                ],
                                "replyTo": payload.get("replyTo"),
                            },
                        },
                    }
                )
            )
            # Legacy companion ack, emitted AFTER action_ack (CONTRACT §1.3).
            await ws.send(
                json.dumps({"type": "send_ack", "payload": {"requestId": request_id}})
            )
            return

        if type_str == "delete_message":
            request_id = payload.get("requestId")
            if payload.get("contextMsgId") == self.bad_delete_id:
                await ws.send(
                    json.dumps(
                        {
                            "type": "error",
                            "payload": {
                                "message": "delete_message failed",
                                "detail": "contextMsgId not found",
                                "code": "not_found",
                                "requestId": request_id,
                                "action": "delete_message",
                            },
                        }
                    )
                )
            else:
                await ws.send(
                    json.dumps(
                        {
                            "type": "action_ack",
                            "payload": {
                                "requestId": request_id,
                                "action": "delete_message",
                                "ok": True,
                                "detail": "deleted",
                                "code": None,
                                "result": {"contextMsgId": payload.get("contextMsgId")},
                            },
                        }
                    )
                )
            return

        if type_str in ("mark_read", "send_presence"):
            # CONTRACT §1.2: these carry no requestId and receive no ack.
            return

        # Generic ok ack for any other request-bearing action.
        request_id = payload.get("requestId")
        if request_id:
            await ws.send(
                json.dumps(
                    {
                        "type": "action_ack",
                        "payload": {
                            "requestId": request_id,
                            "action": type_str,
                            "ok": True,
                            "detail": "ok",
                            "code": None,
                            "result": {},
                        },
                    }
                )
            )


async def start_stub(folder_path: str, **kwargs):
    """Convenience helper: build + start a :class:`StubNodeServer`.

    Returns ``(server, port)``. The caller is responsible for ``await
    server.stop()`` in a ``finally`` block.
    """
    server = StubNodeServer(folder_path, **kwargs)
    port = await server.start()
    return server, port


__all__ = ["StubNodeServer", "start_stub", "BAD_DELETE_ID"]
