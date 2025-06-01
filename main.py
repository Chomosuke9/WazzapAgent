from asyncio import Future, run
from websockets.asyncio.server import serve
from app.bridge.python.server import handle_client
from subprocess import Popen
from dotenv import load_dotenv
from os import getenv

load_dotenv()


async def main():
    await serve(handle_client, "localhost", getenv("PORT"))
    print("Server started on ws://localhost:" + getenv("PORT"))
    Popen(["node", "app/bridge/javascript/handle_msg/bridge.js"]) # Automatically run client
    await Future()  #Keep the server running


if __name__ == "__main__":
    run(main())

