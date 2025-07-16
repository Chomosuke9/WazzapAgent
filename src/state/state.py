"""
Manages the application's state, loading configuration from environment variables
and initializing shared objects.
"""

import os
from asyncio import Queue
from logging import Logger
from typing import Dict

from dotenv import load_dotenv

from ..utils.logger import create_logger

# Load environment variables from a .env file
load_dotenv()

# --- Configuration ---
bot_number: str = (os.getenv("BOT_NUMBER") or "") + "@s.whatsapp.net"
port: str = os.getenv("PORT") or "8765"
key: str | None = os.getenv("KEY")
node_path: str | None = os.getenv("NODE_PATH")

# --- Global State ---
# A dictionary to store connected client information.
# The key is the client identifier, and the value can be any client-specific object.
clients: Dict[object, str] = {}

# A logger instance for the application.
logger: Logger = create_logger("WazzapAgent", 10)

# A dictionary to hold pending feedback queues for different clients.
# The key is the client identifier (e.g., message ID), and the value is an asyncio Queue.
pending_feedback: Dict[str, Queue[Dict[str, str]]] = {}
