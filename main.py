from asyncio import Future, run
from websockets.asyncio.server import serve
from src.bridge.python.server import handle_client
from subprocess import Popen
from src.state.state import port, node_path


async def main():
    await serve(handle_client, "localhost", port)
    print("Server started on ws://localhost:" + port)
    #Popen([node_path, "main.js"], ) # Automatically run client
    await Future()  #Keep the server running


if __name__ == "__main__":
    run(main())
