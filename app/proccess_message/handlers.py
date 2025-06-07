import json
from .parseMessage import parse_whatsapp_message
from websockets.legacy.server import WebSocketServerProtocol
from ..state.state import bot_number, clients, logger





async def handle_message(socket : WebSocketServerProtocol, message : dict) -> None:
    logger.debug(f"Received message: {message}")
    if message.get("type") == "chat":
        data = parse_whatsapp_message(message)
        logger.debug("Parsed message:\n" + json.dumps(data, indent=2, ensure_ascii=False))
        if data.get("mentions"):
            found = any(bot_number in mention for mention in (data.get("mentions") or []) + (data.get("quotedParticipants") or []))
            if found:
                logger.debug("Message contains bot number, sending response...")


async def wait_for_response(socket : WebSocketServerProtocol, uid : str) -> list | None:
    while True:
        data = await socket.recv()
        try :
            data = json.loads(data)
        except json.JSONDecodeError:
            continue
        msg_uid, token, msg_type, content = data.get("uid"), data.get("token"), data.get("type"), data.get("content")
        if msg_uid and token:
            if msg_type == "response" and token == clients[socket]:
                if msg_uid == uid:
                    return content

