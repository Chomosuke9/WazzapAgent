from dotenv import load_dotenv
import os
from ..utils.logger import create_logger
load_dotenv()



bot_number = os.getenv("BOT_NUMBER") + "@s.whatsapp.net"
port = os.getenv("PORT")
key = os.getenv("KEY")
clients = {}
logger = create_logger("test", 10)