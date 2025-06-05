import secrets
import string

def generate_token():
  return ''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(20))

