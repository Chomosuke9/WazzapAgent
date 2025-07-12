import json

def auth_data(status, token):
  """Return a JSON string for an auth data."""
  return json.dumps({"type": "auth", "status": status, "token": token})


def notify_data(content):
  """Return a JSON string for a notify data."""
  return json.dumps({"type": "notify", "message": content})
