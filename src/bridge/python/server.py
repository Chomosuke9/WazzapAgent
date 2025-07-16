from asyncio import create_task, Semaphore
from typing import Any, Dict
import src.bridge.python.auth as auth
from src.bridge.python.data import *
from src.proccess_message.handlers import handle_message
from websockets.legacy.server import WebSocketServerProtocol
from websockets import exceptions
from ...state.state import clients, key, logger
import json

file_name = "log.txt"
sem = Semaphore(10)


async def handle_new_valid_client(websocket: WebSocketServerProtocol) -> None:
    token = auth.generate_token()
    clients[websocket] = token
    await websocket.send(auth_data(status="success", token=token))
    logger.debug("Client successfully connected and authenticated.")


async def handle_websocket_message(websocket: WebSocketServerProtocol, message: str | bytes) -> None:
    """
    Processes a single incoming message from a WebSocket client.
    It handles authentication for new clients and routes messages for existing ones.
    """
    try:
        # The message is expected to be a JSON string.
        msg: Dict[str, Any] = json.loads(message)
    except json.JSONDecodeError:
        logger.error("Invalid message format: Failed to decode JSON.")
        return

    token = msg.get("token")

    # Case 1: Existing, authenticated client sends a message with a valid token.
    if websocket in clients and token == clients.get(websocket):
        async with sem:
            create_task(handle_message(socket=websocket, message=msg))
        # print(json.dumps(msg.get("content"), indent=2))

    # Case 2: New client attempts to authenticate.
    elif websocket not in clients:
        logger.debug("New client trying to connect, checking if key is valid.")
        if msg.get("type") == "auth" and msg.get("key") == key:
            logger.debug("Key is valid, adding to verified clients...")
            await handle_new_valid_client(websocket)
        else:
            logger.debug(f"Unauthorized attempt from new client. Message: {msg}")

    # Case 3: Existing client sends a message with an invalid token.
    elif websocket in clients and token != clients.get(websocket):
        logger.error(f"Invalid token for authenticated client. Message: {msg}")

    # Case 4: Unhandled condition.
    else:
        logger.critical(f"Unknown error processing message: {msg}")


async def handle_client(websocket: WebSocketServerProtocol) -> None:
    """
    Handles a single client connection, processing incoming messages
    and managing the client's lifecycle.
    """
    try:
        async for message in websocket:
            create_task(handle_websocket_message(message=message, websocket=websocket))

    except exceptions.ConnectionClosed as e:
        logger.info(f"Client disconnected: {e}")
    finally:
        if websocket in clients:
            del clients[websocket]
        logger.info("Client disconnected.")
