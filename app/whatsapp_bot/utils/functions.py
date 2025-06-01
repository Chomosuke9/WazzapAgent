import json



async def send_message(sock, target, message, mentions):
      sock.send(json.dumps({"type": "chat", "target": target, "message": message, "mentions" : mentions}))
