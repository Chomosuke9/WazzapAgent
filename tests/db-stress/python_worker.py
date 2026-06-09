from __future__ import annotations

import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from python.bridge import db  # noqa: E402

WORKER_ID = int(os.getenv('WORKER_ID', '0'))
ITERATIONS = int(os.getenv('STRESS_ITERATIONS', '120'))
CHAT_COUNT = int(os.getenv('STRESS_CHAT_COUNT', '24'))
MODES = ('auto', 'prefix', 'hybrid')
TRIGGER_SETS = (('!', '/'), ('!',), ('/',))


def chat_id_for(i: int) -> str:
  return f'stress-chat-{(WORKER_ID + i) % CHAT_COUNT}@g.us'


def assert_present(value: object, message: str) -> None:
  if value is None:
    raise AssertionError(message)


def main() -> int:
  db.add_model('stress-python-model', 'Stress Python Model', 'stress-test model', 101, False)

  for i in range(ITERATIONS):
    chat_id = chat_id_for(i)
    prompt = f'python-{WORKER_ID}-{i}-{time.time_ns()}'
    permission = (WORKER_ID + i) % 4
    mode = MODES[(WORKER_ID + i) % len(MODES)]

    op = i % 11
    if op == 0:
      db.set_prompt(chat_id, prompt)
      assert_present(db.get_prompt(chat_id), 'python prompt read returned None')
    elif op == 1:
      db.set_permission(chat_id, permission)
      assert_present(db.get_permission(chat_id), 'python permission read returned None')
    elif op == 2:
      db.set_mode(chat_id, mode)
      assert_present(db.get_mode(chat_id), 'python mode read returned None')
    elif op == 3:
      db.set_triggers(chat_id, TRIGGER_SETS[i % len(TRIGGER_SETS)])
      assert_present(db.get_triggers(chat_id), 'python triggers read returned None')
    elif op == 4:
      db.set_llm2_model(chat_id, 'stress-python-model')
    elif op == 5:
      db.set_subagent_enabled(chat_id, i % 2 == 0)
      assert_present(db.get_subagent_enabled(chat_id), 'python subagent read returned None')
    elif op == 6:
      db.set_idle_trigger(chat_id, 1 + (i % 5), 3 + (i % 7))
      assert_present(db.get_idle_trigger(chat_id), 'python idle trigger read returned None')
    elif op == 7:
      db.upsert_stats_batch([(chat_id, 'day', '2026-05-07', 'messages', 1)])
      db.get_stats(chat_id, 'day', '2026-05-07')
    elif op == 8:
      sender_ref = f'user-{WORKER_ID}-{i % 12}'
      db.upsert_user_stats_batch([(chat_id, 'day', '2026-05-07', sender_ref, f'User {sender_ref}', 1)])
      db.get_top_users(chat_id, 'day', '2026-05-07', 3)
    elif op == 9:
      db.add_mute(chat_id, f'user-{WORKER_ID}-{i % 12}', 5)
    else:
      db.is_muted(chat_id, f'user-{WORKER_ID}-{i % 12}')

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
