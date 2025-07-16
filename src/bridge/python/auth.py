import secrets
import string
from ...state.state import logger

def generate_token() -> str:
    """Generates a secure, random 20-character token."""
    logger.debug("Generating token...")
    return "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(20))

