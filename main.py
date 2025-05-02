import asyncio
from websockets.asyncio.server import serve
from app.bridge.python.handle_connection import handle_client
import dotenv
import os

dotenv.load_dotenv()
port = os.getenv("PORT")

async def main():
    async with serve(handle_client, "localhost", port):
        print("Server berjalan di ws://localhost:" + port)
        await asyncio.Future()  # menjaga server tetap hidup

if __name__ == "__main__":
    asyncio.run(main())
