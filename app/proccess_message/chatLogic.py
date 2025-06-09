from ..whatsapp_bot.utils.functions import *


async def process_message(socket : WebSocketServerProtocol, message_data: dict) -> None:
    if message_data.get("type") == "text":
        if message_data.get("message") == "tag everyone":
            await tag_everyone(sock=socket, target = message_data.get("remoteJid"))

        elif message_data.get("message") == "test1":
            await send_message(sock=socket, target=message_data.get("remoteJid"), message="sending simple message")

        elif message_data.get("message") == "test2":
            await send_message_and_get_info(sock=socket, target=message_data.get("remoteJid"), message="sending message and getting info")

