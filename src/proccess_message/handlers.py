import json
from typing import Any, Dict
from websockets.legacy.server import WebSocketServerProtocol
from ..state.state import logger, pending_feedback
from .chatLogic import process_message



async def handle_message(socket : WebSocketServerProtocol, message : Dict[str, Any]) -> None:
    """
    Handles incoming messages, routing them based on their type.
    """
    logger.debug(f"Received message: {message}")
    message_type: str | None = message.get("type")

    if message_type == "chat":
        await process_message(socket=socket, message_data=message)
        #if data.get("mentions"):
        #    found = any(bot_number in mention for mention in (data.get("mentions") or []) + (data.get("quotedParticipants") or []))
        #    if found:
        #       logger.debug("Message contains bot number, sending response...")
    elif message_type == "feedback":
        uid = message.get("id")
        if not uid:
            logger.warning(f"Feedback received without a message ID: {message}")
            return
            
        queue = pending_feedback.get(uid)
        if queue:
            await queue.put(message)
        else:
            logger.warning(f"Received feedback for an unknown message ID: {uid}")

    elif message_type == "notify":
        content = message.get("content", "Notification received with no content.")
        logger.info(content)




