from dotenv import load_dotenv
import os
load_dotenv()



bot_number = os.getenv("BOT_NUMBER") + "@s.whatsapp.net"
port = os.getenv("PORT")
key = os.getenv("KEY")
clients = {}