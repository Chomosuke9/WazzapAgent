"""``IdleTrigger`` — probabilistic idle re-engagement decision (Step 08).

Wraps the pure ``_compute_idle_trigger`` arithmetic (session.py ~440) and the
``_should_idle_trigger`` closure (session.py ~659). The DB read for the per-chat
idle config is injected as ``get_idle_trigger`` so the collaborator is testable
with a fake — no DB / socket / LLM required. Behaviour is identical to the
original closures.
"""
from __future__ import annotations

import random
from typing import Callable, Optional, Tuple


class IdleTrigger:
  """Decides whether the bot should re-engage based on the idle message count.

  :param get_idle_trigger: callable ``(chat_id) -> (min_val, max_val) | None``
    returning the per-chat idle config (``None`` when idle trigger is disabled).
  """

  def __init__(self, *, get_idle_trigger: Callable[[str], Optional[Tuple[int, int]]]) -> None:
    self._get_idle_trigger = get_idle_trigger

  @staticmethod
  def compute(min_val: int, max_val: int, msg_count: int) -> bool:
    """Pure logic for idle trigger probability. No DB calls."""
    if msg_count < min_val:
      return False
    if min_val == max_val:
      return True
    if msg_count >= max_val:
      return True
    return random.random() < (1.0 / (max_val - msg_count + 1))

  def should_trigger(self, chat_id: str, msg_count: int) -> bool:
    """Check if the idle trigger should fire based on the message count."""
    cfg = self._get_idle_trigger(chat_id)
    if not cfg:
      return False
    min_val, max_val = cfg
    return self.compute(min_val, max_val, msg_count)
