from __future__ import annotations

import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from python.bridge import db  # noqa: E402

WORKER_ID = int(os.getenv('WORKER_ID', '0'))
ITERATIONS = int(os.getenv('STRESS_ITERATIONS', '30'))
CHAT_COUNT = int(os.getenv('STRESS_CHAT_COUNT', '12'))


def chat_id_for(i: int) -> str:
  return f'xproc-chat-{(WORKER_ID + i) % CHAT_COUNT}@g.us'


def main() -> int:
  db.add_model(f'xproc-pymodel-{WORKER_ID}', f'CrossProc Py {WORKER_ID}', 'test', WORKER_ID + 400, False)

  for i in range(ITERATIONS):
    chat_id = chat_id_for(i)
    prompt = f'xproc-py-{WORKER_ID}-{i}-{time.time_ns()}'
    mode = ('auto', 'prefix', 'hybrid')[i % 3]
    enabled = i % 2 == 0

    # Write
    db.set_prompt(chat_id, prompt)
    db.set_mode(chat_id, mode)
    db.set_subagent_enabled(chat_id, enabled)
    db.set_llm2_model(chat_id, f'xproc-pymodel-{WORKER_ID}')

    # Immediately read back
    read_prompt = db.get_prompt(chat_id)
    read_mode = db.get_mode(chat_id)
    read_enabled = db.get_subagent_enabled(chat_id)
    read_model = db.get_llm2_model(chat_id)

    if read_prompt != prompt:
      raise AssertionError(
        f'xproc py-{WORKER_ID}: prompt mismatch for {chat_id}: '
        f'expected "{prompt}", got "{read_prompt}"'
      )
    if read_mode != mode:
      raise AssertionError(
        f'xproc py-{WORKER_ID}: mode mismatch for {chat_id}: '
        f'expected "{mode}", got "{read_mode}"'
      )
    if read_enabled != enabled:
      raise AssertionError(
        f'xproc py-{WORKER_ID}: subagent mismatch for {chat_id}: '
        f'expected {enabled}, got {read_enabled}'
      )
    if read_model != f'xproc-pymodel-{WORKER_ID}':
      raise AssertionError(
        f'xproc py-{WORKER_ID}: model mismatch for {chat_id}: '
        f'expected "xproc-pymodel-{WORKER_ID}", got "{read_model}"'
      )

  db.close_all_connections()
  return 0


if __name__ == '__main__':
  try:
    raise SystemExit(main())
  except Exception as exc:
    try:
      db.close_all_connections()
    except Exception:
      pass
    print(repr(exc), file=sys.stderr)
    raise