import json
from typing_extensions import Buffer


def chat_data(message : str, mentions : list[str]=None, sendAsReply : str =None, image : Buffer|str =None, video : Buffer|str =None):
    """Return a JSON string for a chat data."""
    return json.dumps({"type": "chat", "content": {"message": message, "mentions": mentions, "sendAsReply": sendAsReply, "image": image, "video": video}})


def auth_data(status, token):
    """Return a JSON string for an auth data."""
    return json.dumps({"type": "auth", "status": status, "token": token})


def notify_data(content):
    """Return a JSON string for a notify data."""
    return json.dumps({"type": "notify", "message": content})