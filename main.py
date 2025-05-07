import asyncio
from websockets.asyncio.server import serve
from app.bridge.python.handle_connection import handle_client
import subprocess
import dotenv
import os

dotenv.load_dotenv()
port = os.getenv("PORT")

async def main():
    await serve(handle_client, "localhost", port)
    print("Server berjalan di ws://localhost:" + port)
    subprocess.Popen(["node", "app/bridge/javascript/handle_msg/bridge.js"]) # Automatically run client
    await asyncio.Future()  #Keep the server running


if __name__ == "__main__":
    asyncio.run(main())

