import json
from websockets.legacy.server import WebSocketServerProtocol
from random import randbytes
from asyncio import wait_for, Queue, TimeoutError
from ...state.state import logger, clients, pending_feedback

async def wait_for_response(socket : WebSocketServerProtocol, uid : str) -> list[str|int]:
    """
    Waiting for specific uid to be received, perfect if you want to send a message and wait for a response
    :param socket: WebSocket
    :param uid: uid to wait for
    :return: list of data
    """
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



async def send_message(sock: WebSocketServerProtocol, target: str, message: str,
                       mentions: str | list[str] | None = None) -> None:
    """
      Send a simple message to target
      :param sock: WebSocket
      :param target: JID of target (Group or User)
      :param message: Message
      :param mentions: (Optional) JID of Participants to mention (Only works for groups)
      :return: None
      """
    logger.info(f"Sending message: {message}")
    await sock.send(json.dumps({"type": "simpleChat", "target": target, "message": message, "mentions": mentions}))


async def send_message_and_get_key(sock: WebSocketServerProtocol, target: str, message: str, mentions: list[str] | str = None, timeout: int = 10) -> str:
    """
      Send a message and get info of the message
      :param sock: WebSocket
      :param target: JID of target (Group or User)
      :param message: Message
      :param mentions: (Optional) JID of Participants to mention (Only works for groups)
      :return: id of the message
      """
    logger.debug(f"Waiting for response from client. Function: send_message_and_get_key")
    logger.info(f"Sending message and getting key message")
    uid = randbytes(5).hex()
    logger.debug(f"Generating uid: {uid}")
    queue = Queue()
    pending_feedback[uid] = queue
    await sock.send(
        json.dumps({"type": "chatAndGetInfo", "uid": uid, "target": target, "message": message, "mentions": mentions}))
    try:
        message_info = await wait_for(queue.get(), timeout=timeout)
        logger.debug(f"Received message key for uid: {uid}")
        key = message_info.get('content', {}).get('key', {})
        if key:
            logger.debug(f"Message key: {json.dumps(key, indent=2, ensure_ascii=False)}")
            return key
        else:
            logger.warning(f"Message id not found for uid: {uid}")
    except TimeoutError:
        logger.warning(f"Timeout waiting for feedback for uid: {uid}")
        return None
    finally:
        pending_feedback.pop(uid, None)
        logger.debug(f"Removed pending feedback for uid: {uid}")


async def tag_everyone(sock: WebSocketServerProtocol, target: str) -> None:
    """
    Tag everyone in group
    :param sock: WebSocket
    :param target: JID of group
    :return: None
    """
    if target[-5:] == "@g.us":
        await sock.send(json.dumps({"type": "tagEveryone", "target": target}))
        logger.info(f"Tagging everyone in group: {target}")
    elif target[-3:] == "net":
        logger.error("Tagging everyone is not supported for private chats")

async def edit_message(sock: WebSocketServerProtocol, message: str, key: dict) -> None:
    await sock.send(json.dumps({"type": "editMessage", "message": message, "key": key}))


async def send_button_message(sock: WebSocketServerProtocol, target: str, quoted_message : json) -> None:
    await sock.send(json.dumps({"type": "sendButton", "target": target, "quoted": quoted_message}))