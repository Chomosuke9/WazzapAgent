import json


def auth_data(status: str, token: str) -> str:
    """
    Creates a JSON string for authentication purposes.

    Args:
        status: The authentication status (e.g., "success").
        token: The token to be sent.

    Returns:
        A JSON-formatted string.
    """
    return json.dumps({"type": "auth", "status": status, "token": token})


def notify_data(content: str) -> str:
    """
    Creates a JSON string for notification purposes.

    Args:
        content: The notification message string.

    Returns:
        A JSON-formatted string.
    """
    return json.dumps({"type": "notify", "message": content})
