import shutil
import json
import os


def clear_auth_state(path : str, file_name : str ="creds.json"):
  try:
    creds = os.path.join(path, file_name)
    with open(creds, "r", encoding="utf-8") as f:
      state = json.load(f)
    shutil.rmtree(path, ignore_errors=True)
    os.makedirs(path, exist_ok=True)
    with open(creds, "w", encoding="utf-8") as f:
      json.dump(state, f, indent=2)
  except Exception as e:
    print(e)

if __name__ == "__main__":
  clear_auth_state("../../../auth_info_baileys", "creds.json")
