import json
import app.bridge.python.auth as auth
from app.bridge.python.process_data import data

clients = {}
secret_key = auth.get_key()

async def handle_new_valid_client(websocket):
  token = auth.generate_token()
  clients[websocket] = token
  await websocket.send(data(type="auth", status="success", token=token))
  print(clients)

async def handle_client(websocket):
  try:
    async for message in websocket:
      print("Received message:", message)
      try:
        msg = json.loads(message)
      except json.JSONDecodeError:
        await websocket.send(data(type="notify", content="Invalid JSON"))
        continue

      if websocket in clients and msg.get("token") == clients[websocket]:
        if msg.get("type") == "notify":
          await websocket.send(data(type="notify", content="Test Successfully"))
        else:
          await websocket.send(data(type="notify", content=f"Type error..., Type = {msg.get('type')}"))

      elif websocket not in clients:
        if msg.get("type") == "auth" and msg.get("key") == secret_key:
          await websocket.send(data(type="notify", content="Authenticated Successfully, adding to verified clients..."))
          await handle_new_valid_client(websocket)

        else:
          await websocket.send(data(type="notify", content="Unauthorized. Please authenticate."))

      else:
        await websocket.send(data(type="notify", content=f"Something wrong... {msg}"))



  except Exception as e:
    print("Error:", e)
  finally:
    if websocket in clients:
      del clients[websocket]
    print("Client disconnected:", websocket)
