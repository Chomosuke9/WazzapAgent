from ..whatsapp_bot.utils.functions import *
from asyncio import sleep
from .frame import frames
from  .parseMessage import  parse_whatsapp_message

editmsg=["Loading", "Loading.", "Loading..", "Loading..."]

async def process_message(socket : WebSocketServerProtocol, message_data: dict) -> None:
    data = parse_whatsapp_message(message_data)
    logger.debug("Parsed message:\n" + json.dumps(data, indent=2, ensure_ascii=False))

    if data.get("type") == "text":
        if data.get("message") == "tag everyone":
            await tag_everyone(sock=socket, target = data.get("remoteJid"))

        elif data.get("message") == "test1":
            await send_message(sock=socket, target=data.get("remoteJid"), message="sending simple message")

        elif data.get("message") == "test2":
            key = await send_message_and_get_key(sock=socket, target=data.get("remoteJid"), message="sending message and getting info")
            await edit_message(sock=socket, message=f"test successfull : {key}", key=key)

        elif data.get("message") == "test3":
            key = await send_message_and_get_key(sock=socket, target=data.get("remoteJid"), message="sending message and getting info")
            for i in range(6):
                print(i)
                await edit_message(sock=socket, message=editmsg[i%4], key=key)
                await sleep(0.5)

        elif data.get("message") == "test4":
            quoted_msg = message_data.get('content', {}).get('messages', [{}])[0]
            print("quoted message: ", quoted_msg)
            await send_button_message(sock=socket, target=data.get("remoteJid"), quoted_message=quoted_msg)
    else:
        pass