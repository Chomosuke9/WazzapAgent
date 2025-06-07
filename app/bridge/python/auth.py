import secrets
import string
from ...state.state import logger

def generate_token():
  logger.debug("Generating token...")
  return ''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(20))

