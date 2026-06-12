"""``ReplyDedup`` — near-duplicate LLM reply suppression (Step 08).

Wraps the ``_is_duplicate_reply`` closure (session.py ~637) and owns its dedup
window state (the per-chat deque of ``(timestamp_ms, signature)`` pairs). The
dedup window / minimum-character thresholds and the ``reply_signature`` function
are injected so the collaborator is unit-testable with fakes — no socket / LLM.
Behaviour is identical to the original closure.
"""
from __future__ import annotations

import time
from collections import defaultdict, deque
from typing import Callable, Deque, Dict, Optional, Tuple


class ReplyDedup:
  """Tracks recently-sent reply signatures per chat to suppress duplicates.

  :param window_ms: dedup window in ms (``<= 0`` disables dedup entirely).
  :param min_chars: minimum signature length below which dedup is skipped.
  :param reply_signature: callable ``(text) -> str`` building the comparison key.
  :param max_entries: cap on retained signatures per chat (default 24).
  :param now_ms: injectable clock returning current epoch ms (default real clock).
  """

  def __init__(
    self,
    *,
    window_ms: int,
    min_chars: int,
    reply_signature: Callable[[Optional[str]], str],
    max_entries: int = 24,
    now_ms: Optional[Callable[[], int]] = None,
  ) -> None:
    self._window_ms = window_ms
    self._min_chars = min_chars
    self._reply_signature = reply_signature
    self._max_entries = max_entries
    self._now_ms = now_ms or (lambda: int(time.time() * 1000))
    self.signatures_by_chat: Dict[str, Deque[Tuple[int, str]]] = defaultdict(deque)

  def is_duplicate(self, chat_id: str, text: Optional[str]) -> bool:
    if self._window_ms <= 0:
      return False

    signature = self._reply_signature(text)
    if len(signature) < self._min_chars:
      return False

    now_ms = self._now_ms()
    cutoff = now_ms - self._window_ms
    items = self.signatures_by_chat[chat_id]
    while items and items[0][0] < cutoff:
      items.popleft()

    if any(prev_sig == signature for _, prev_sig in items):
      return True

    items.append((now_ms, signature))
    while len(items) > self._max_entries:
      items.popleft()
    return False
