from dotenv import load_dotenv
import os
from ..utils.logger import create_logger
load_dotenv()
from asyncio import Queue


bot_number = os.getenv("BOT_NUMBER") + "@s.whatsapp.net"
port = os.getenv("PORT")
key = os.getenv("KEY")
clients = {}
logger = create_logger("test", 10)
# Bisa di module-level
pending_feedback: dict[str, Queue] = {}
