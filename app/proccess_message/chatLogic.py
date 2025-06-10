from ..whatsapp_bot.utils.functions import *
from asyncio import sleep
from .frame import frames

editmsg=["Loading", "Loading.", "Loading..", "Loading..."]

async def process_message(socket : WebSocketServerProtocol, message_data: dict) -> None:
    if message_data.get("type") == "text":
        if message_data.get("message") == "tag everyone":
            await tag_everyone(sock=socket, target = message_data.get("remoteJid"))

        elif message_data.get("message") == "test1":
            await send_message(sock=socket, target=message_data.get("remoteJid"), message="sending simple message")

        elif message_data.get("message") == "test2":
            key = await send_message_and_get_key(sock=socket, target=message_data.get("remoteJid"), message="sending message and getting info")
            await sleep(3)
            for i in range(420):
                print(i)
                await edit_message(sock=socket, message=frames[i%42], key=key)
                await sleep(0.05)
