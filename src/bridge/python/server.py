from asyncio import create_task, Semaphore
import src.bridge.python.auth as auth
from src.bridge.python.data import *
from src.proccess_message.handlers import handle_message
from websockets.legacy.server import WebSocketServerProtocol
from websockets import exceptions
from ...state.state import clients, key, logger

file_name = "log.txt"
sem = Semaphore(10)

async def handle_new_valid_client(websocket: WebSocketServerProtocol) -> None:
    token = auth.generate_token()
    clients[websocket] = token
    await websocket.send(auth_data(status="success", token=token))
    logger.debug("Client successfully connected and authenticated.")

async def handle_websocket_message( websocket: WebSocketServerProtocol, message) -> None:
    try:
        msg = json.loads(message)
    except json.JSONDecodeError:
        logger.error("Invalid message format")
        return

    if websocket in clients and msg.get("token") == clients[websocket]:
        async with sem:
            create_task(handle_message(socket=websocket, message=msg))
        #print(json.dumps(msg.get("content"), indent=2))

    elif websocket not in clients:
        logger.debug("New client trying to connect, checking if key are valid.")
        if msg.get("type") == "auth" and msg.get("key") == key:
            logger.debug("Key are valid, adding to verified clients...")
            await handle_new_valid_client(websocket)

        else:
            logger.debug("Unauthorized")

    elif websocket in clients and msg.get("token") != clients[websocket]:
        logger.error("Invalid token")
        logger.error("Message : ", msg)
    else:
        logger.critical(f"Unknown error: {msg}")


async def handle_client(websocket: WebSocketServerProtocol) -> None:
    try:
        async for message in websocket:
            create_task(handle_websocket_message(message=message, websocket=websocket))

    except exceptions.ConnectionClosed as e:
        logger.info(f"Client disconnected : {e}")
    finally:
        if websocket in clients:
            del clients[websocket]
        logger.info("Client disconnected.")