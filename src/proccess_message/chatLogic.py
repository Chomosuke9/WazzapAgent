from ..whatsapp_bot.utils.functions import *
from asyncio import sleep


editmsg=["Loading", "Loading.", "Loading..", "Loading..."]

async def process_message(socket : WebSocketServerProtocol, data: dict) -> None:
    logger.debug("Parsed message:\n" + json.dumps(data, indent=2, ensure_ascii=False))

    if data.get("type") == "chat":
        message : str = data.get("content", {}).get("message", "")
        content = data.get("content", {})
        if message == "tag everyone":
            await tag_everyone(sock=socket, target = content.get("remoteJid"))

        elif message == "test1":
            await send_message(sock=socket, target=content.get("remoteJid"), message="sending simple message")

        elif message == "test2":
            key = await send_message_and_get_key(sock=socket, target=content.get("remoteJid"), message="sending message and getting info")
            await edit_message(sock=socket, message=f"test successfull : {key}", key=key)

        elif message == "test3":
            key = await send_message_and_get_key(sock=socket, target=content.get("remoteJid"), message="sending message and getting info")
            for i in range(16):
                print(i)
                await edit_message(sock=socket, message=editmsg[i%4], key=key)
                await sleep(0.5)

        elif message == "test4":
            quoted_msg = data.get('content', {}).get('messages', [{}])[0]
            print("quoted message: ", quoted_msg)
            await send_button_message(sock=socket, target=content.get("remoteJid"), quoted_message=quoted_msg)
    else:
        pass