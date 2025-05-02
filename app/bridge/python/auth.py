import secrets
import string
from dotenv import load_dotenv
import os

load_dotenv()
def get_key():
  return os.getenv("KEY")


def generate_token():
  return ''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(20))

