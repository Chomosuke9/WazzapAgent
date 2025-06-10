import json
from .parseMessage import parse_whatsapp_message
from websockets.legacy.server import WebSocketServerProtocol
from ..state.state import logger, pending_feedback
from .chatLogic import process_message




async def handle_message(socket : WebSocketServerProtocol, message : dict) -> None:
    logger.debug(f"Received message: {message}")
    if message.get("type") == "chat":
        data = parse_whatsapp_message(message)
        logger.debug("Parsed message:\n" + json.dumps(data, indent=2, ensure_ascii=False))
        await process_message(socket=socket, message_data=data)
        #if data.get("mentions"):
        #    found = any(bot_number in mention for mention in (data.get("mentions") or []) + (data.get("quotedParticipants") or []))
        #    if found:
        #       logger.debug("Message contains bot number, sending response...")
    elif message.get("type") == "feedback":
        uid = message.get("id")
        queue = pending_feedback.get(uid)
        if queue:
            await queue.put(message)
        else:
            logger.warning(f"Received feedback with unknown uid: {uid}")




