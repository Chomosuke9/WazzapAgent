import json
from .parse_message import parse_whatsapp_message
from dotenv import load_dotenv
import os

load_dotenv()
bot_number = os.getenv("BOT_NUMBER") + "@s.whatsapp.net"

async def handle_message(socket, message):
    print(message)
    if message.get("type") == "chat":
        data = parse_whatsapp_message(message)
        print(json.dumps(data, indent=2, ensure_ascii=False))
        if data.get("mentions"):
            found = any(bot_number in mention for mention in (data.get("mentions") or []) + (data.get("quotedParticipants") or []))
            if found:
                print("Bot found in message")
