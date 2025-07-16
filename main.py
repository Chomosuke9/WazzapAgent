from asyncio import Future, run
from websockets.asyncio.server import serve
from src.bridge.python.server import handle_client
from os import popen # type: ignore
from src.state.state import port, node_path # type: ignore


async def main() -> None:
    """Starts the WebSocket server and keeps it running."""
    await serve(handle_client, "localhost", int(port)) # type: ignore
    print(f"Server started on ws://localhost:{port}")
    # Popen([node_path, "main.js"], ) # Automatically run client
    await Future()  # Keep the server running


if __name__ == "__main__":
    run(main())
