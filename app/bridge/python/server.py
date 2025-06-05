from asyncio import create_task, Semaphore
import app.bridge.python.auth as auth
from app.bridge.python.data import *
from app.proccess_message.handlers import handle_message
from websockets.legacy.server import WebSocketServerProtocol
from ...state.state import clients, key

sem = Semaphore(10)

async def handle_new_valid_client(websocket: WebSocketServerProtocol) -> None:
  token = auth.generate_token()
  clients[websocket] = token
  await websocket.send(auth_data(status="success", token=token))
  print(clients)

async def handle_websocket_message( websocket: WebSocketServerProtocol, message) -> None:
      try:
        msg = json.loads(message)
      except json.JSONDecodeError:
        await websocket.send(notify_data(content="Invalid JSON"))
        return

      if websocket in clients and msg.get("token") == clients[websocket]:
        async with sem:
          create_task(handle_message(websocket, msg))

      elif websocket not in clients:
        if msg.get("type") == "auth" and msg.get("key") == key:
          await websocket.send(notify_data(content="Authenticated Successfully, adding to verified clients..."))
          await handle_new_valid_client(websocket)

        else:
          await websocket.send(notify_data(content="Unauthorized. Please authenticate."))

      elif websocket in clients and msg.get("token") != clients[websocket]:
        await websocket.send(notify_data(content="Unauthorized. Please authenticate."))
      else:
        await websocket.send(notify_data(content=f"Something wrong... {msg}"))


async def handle_client(websocket: WebSocketServerProtocol) -> None:
  try:
    async for message in websocket:
      #print("Received message:", message)
      create_task(handle_websocket_message(message=message, websocket=websocket))

  except Exception as e:
    print("Error:", e)
  finally:
    if websocket in clients:
      del clients[websocket]
    print("Client disconnected:", websocket)