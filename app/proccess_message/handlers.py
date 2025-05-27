
def handle_message(message):
    print(message)
    if message.get("type") == "chat":
        content = message.get("content")
        # TODO: handle message