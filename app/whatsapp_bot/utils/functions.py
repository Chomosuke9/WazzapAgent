import json
from websockets.legacy.server import WebSocketServerProtocol


async def send_message(sock : WebSocketServerProtocol, target : str, message : str, mentions : list[str]|str) -> None:
      await sock.send(json.dumps({"type": "chat", "target": target, "message": message, "mentions" : mentions}))

async def send_message_and_get_info(sock : WebSocketServerProtocol, target: str, message:str, mentions: list[str]|str) -> dict:
      await sock.send(json.dumps({"type": "chat", "target": target, "message": message, "mentions" : mentions}))

send_message(target="", message="", mentions="")