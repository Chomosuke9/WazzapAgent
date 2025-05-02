import json



def data(type: str, token: str = None, content=None, status=None):
  if type == "chat":
    return json.dumps({"type": "chat", "content": content})
  elif type == "notify":
    return json.dumps({"type": "notify", "message": content})
  elif type == "auth":
    return json.dumps({"type": "auth", "status": status, "token": token})
  else:
    raise Exception("Invalid type")