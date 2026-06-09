"""
Minimal LLM-side WebSocket server example for the WhatsApp gateway.

What it does:
- Accepts a gateway connection on ws://0.0.0.0:8080/ws
- Logs incoming messages (including contextMsgId and senderRef)
- Sends structured commands back (`send_message`, `delete_message`, `kick_member`)

Commands you can try from WhatsApp:
- `/echo hello` -> sends a reply
- `/delete` -> deletes the current message by contextMsgId
- `/kick u8k2d1@000125,u1m9qa@000124` -> sends a kick_member request

Requirements:
- Python 3.10+
- websockets==12.*, pydantic>=2

Run:
    python examples/llm_ws_echo.py
"""

import asyncio
import json
import re
import time
from typing import Any, Dict

import websockets
from pydantic import BaseModel, Field
from websockets.legacy.auth import WebSocketServerProtocol


KICK_TARGET_RE = re.compile(r"^([A-Za-z0-9][A-Za-z0-9_-]{1,31})@(\d{6})$")


class IncomingMessage(BaseModel):
    instanceId: str
    contextMsgId: str
    messageId: str
    chatId: str
    chatName: str
    chatType: str
    isGroup: bool
    botIsAdmin: bool = False
    botIsSuperAdmin: bool = False
    senderId: str
    senderRef: str | None = None
    senderName: str
    senderIsAdmin: bool = False
    fromMe: bool = False
    contextOnly: bool = False
    triggerLlm1: bool = False
    timestampMs: int
    messageType: str
    text: str | None = None
    quoted: Dict[str, Any] | None = None
    attachments: list[Dict[str, Any]] = Field(default_factory=list)


def request_id(prefix: str) -> str:
    return f"{prefix}-{int(time.time() * 1000)}"


def parse_kick_targets(raw: str) -> list[Dict[str, str]]:
    targets = []
    for item in raw.split(','):
        token = item.strip().lower()
        if not token:
            continue
        match = KICK_TARGET_RE.match(token)
        if not match:
            continue
        targets.append(
            {
                "senderRef": match.group(1),
                "anchorContextMsgId": match.group(2),
            }
        )
    return targets


async def handle_incoming_message(websocket: WebSocketServerProtocol, msg: IncomingMessage) -> None:
    print(
        f"[{msg.chatName}] <{msg.contextMsgId}> {msg.senderName} ({msg.senderRef}): {msg.text!r} "
        f"contextOnly={msg.contextOnly} fromMe={msg.fromMe}"
    )

    if msg.contextOnly:
        return

    text = (msg.text or "").strip()
    if text.startswith('/delete'):
        await websocket.send(
            json.dumps(
                {
                    "type": "delete_message",
                    "payload": {
                        "requestId": request_id("del"),
                        "chatId": msg.chatId,
                        "contextMsgId": msg.contextMsgId,
                    },
                }
            )
        )
        return

    if text.startswith('/kick'):
        raw_targets = text[len('/kick') :].strip()
        targets = parse_kick_targets(raw_targets)
        await websocket.send(
            json.dumps(
                {
                    "type": "kick_member",
                    "payload": {
                        "requestId": request_id("kick"),
                        "chatId": msg.chatId,
                        "targets": targets,
                        "mode": "partial_success",
                        "autoReplyAnchor": True,
                    },
                }
            )
        )
        return

    reply_text = text[len('/echo') :].strip() if text.startswith('/echo') else f"Echo: {msg.text or '(no text)'}"
    await websocket.send(
        json.dumps(
            {
                "type": "send_message",
                "payload": {
                    "requestId": request_id("send"),
                    "chatId": msg.chatId,
                    "text": reply_text,
                    "replyTo": msg.contextMsgId,
                    "attachments": [],
                },
            }
        )
    )


async def handler(websocket: WebSocketServerProtocol):
    async for raw in websocket:
        try:
            event = json.loads(raw)
        except json.JSONDecodeError:
            print("Received non-JSON payload, ignoring")
            continue

        event_type = event.get("type")
        if event_type == "hello":
            print(f"Gateway connected: {event.get('payload')}")
            continue

        if event_type in {"action_ack", "send_ack", "error", "whatsapp_status"}:
            print(f"Gateway event {event_type}: {event.get('payload')}")
            continue

        if event_type != "incoming_message":
            print(f"Other event: {event_type}")
            continue

        try:
            msg = IncomingMessage.model_validate(event["payload"])
        except Exception as exc:
            print(f"Failed to parse incoming_message: {exc}")
            continue

        await handle_incoming_message(websocket, msg)


async def main():
    server = await websockets.serve(
        handler,
        host="0.0.0.0",
        port=8080,
        path="/ws",
        max_size=20 * 1024 * 1024,
        ping_interval=20,
        ping_timeout=20,
    )
    print("LLM WS server listening on ws://0.0.0.0:8080/ws")
    await server.wait_closed()


if __name__ == "__main__":
    asyncio.run(main())
