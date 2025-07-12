import json
from websockets.legacy.server import WebSocketServerProtocol
from ..state.state import logger, pending_feedback
from .chatLogic import process_message



async def handle_message(socket : WebSocketServerProtocol, message : dict) -> None:
    logger.debug(f"Received message: {message}")
    type : str | None = message.get("type")
    if type == "chat":
        await process_message(socket=socket, message_data=message)
        #if data.get("mentions"):
        #    found = any(bot_number in mention for mention in (data.get("mentions") or []) + (data.get("quotedParticipants") or []))
        #    if found:
        #       logger.debug("Message contains bot number, sending response...")
    elif type == "feedback":
        uid = message.get("id")
        queue = pending_feedback.get(uid)
        if queue:
            await queue.put(message)
        else:
            logger.warning(f"Received feedback with unknown uid: {uid}")

    elif type == "notify":
        logger.info(message.get("content"))




