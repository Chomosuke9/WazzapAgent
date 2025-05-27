import asyncio
from app.whatsapp_bot.utils.functions import clear_auth_state
from websockets.asyncio.server import serve
from app.bridge.python.server import handle_client
import subprocess
import dotenv
import os

dotenv.load_dotenv()


async def main():
    await serve(handle_client, "localhost", os.getenv("PORT"))
    print("Server berjalan di ws://localhost:" + os.getenv("PORT"))
    subprocess.Popen(["node", "app/bridge/javascript/handle_msg/bridge.js"]) # Automatically run client
    await asyncio.Future()  #Keep the server running


if __name__ == "__main__":
    #clear_auth_state(os.getenv("AUTH_STATE_FILE"), "creds.json") #Optional if you want to clear your key
    asyncio.run(main())

