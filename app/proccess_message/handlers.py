
def handle_message(message):
    if message.get("type") == "chat":
        print(message.get("content"))