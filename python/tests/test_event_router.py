"""Step 10 — ``EventRouter`` per-type control-event routing tests.

Drives :meth:`bridge.agent.event_router.EventRouter.handle` directly with the
control-event dicts Node emits (``clear_history`` / ``set_llm2_model`` /
``invalidate_*`` / ``set_subagent_enabled``) and asserts each branch performs
the same cache-invalidation + per-account state effect the former
``_dispatch_event`` closure did.

Discipline (matching the suite): NO pytest-asyncio — every coroutine is driven
with :func:`asyncio.run`. The router is constructed with fakes (no DB / socket),
so the tests are fast and cannot hang.
"""
from __future__ import annotations

import asyncio
from collections import defaultdict, deque

from bridge.agent.event_router import EventRouter


class _FakeTracker:
  def __init__(self, calls):
    self._calls = calls

  def clear_all(self):
    self._calls.append(("tracker_clear_all",))

  def clear_history_for_chat(self, chat_id):
    self._calls.append(("tracker_clear_chat", chat_id))


def _make(calls):
  per_chat = defaultdict(deque)
  per_chat["c@x"].append("m1")
  per_chat["c@y"].append("m2")
  idle = defaultdict(int)
  idle["c@x"] = 5
  idle["c@y"] = 3
  router = EventRouter(
    per_chat=per_chat,
    idle_msg_count=idle,
    subagent_tracker=_FakeTracker(calls),
    reset_settings_connection=lambda: calls.append(("reset",)),
    invalidate_chat_caches=lambda c: calls.append(("invalidate_chat", c)),
    clear_llm2_model_cache=lambda c: calls.append(("clear_llm2", c)),
    set_llm2_model=lambda c, m: calls.append(("set_llm2", c, m)),
    clear_subagent_enabled_cache=lambda c: calls.append(("clear_sub", c)),
  )
  return router, per_chat, idle


def test_clear_history_global_clears_everything():
  calls = []
  router, per_chat, idle = _make(calls)
  asyncio.run(router.handle({"type": "clear_history", "chatId": "global"}))
  assert len(per_chat) == 0
  assert len(idle) == 0
  assert ("tracker_clear_all",) in calls
  assert ("reset",) in calls


def test_clear_history_single_chat_only_touches_that_chat():
  calls = []
  router, per_chat, idle = _make(calls)
  asyncio.run(router.handle({"type": "clear_history", "chatId": "c@x"}))
  assert list(per_chat["c@x"]) == []        # cleared
  assert list(per_chat["c@y"]) == ["m2"]    # untouched
  assert "c@x" not in idle                   # popped
  assert idle["c@y"] == 3
  assert ("tracker_clear_chat", "c@x") in calls
  assert ("invalidate_chat", "c@x") in calls


def test_set_llm2_model_chat_writes_model():
  calls = []
  router, *_ = _make(calls)
  asyncio.run(router.handle({"type": "set_llm2_model", "chatId": "c@x", "modelId": "gpt-4o"}))
  assert ("set_llm2", "c@x", "gpt-4o") in calls


def test_set_llm2_model_global_resets_settings():
  calls = []
  router, *_ = _make(calls)
  asyncio.run(router.handle({"type": "set_llm2_model", "chatId": "global", "modelId": "x"}))
  assert ("reset",) in calls
  assert not any(c[0] == "set_llm2" for c in calls)


def test_invalidate_llm2_model_chat_clears_cache():
  calls = []
  router, *_ = _make(calls)
  asyncio.run(router.handle({"type": "invalidate_llm2_model", "chatId": "c@x"}))
  assert ("clear_llm2", "c@x") in calls


def test_invalidate_default_model_resets_settings():
  calls = []
  router, *_ = _make(calls)
  asyncio.run(router.handle({"type": "invalidate_default_model"}))
  assert ("reset",) in calls


def test_set_subagent_enabled_chat_clears_cache_and_resets():
  calls = []
  router, *_ = _make(calls)
  asyncio.run(router.handle({"type": "set_subagent_enabled", "chatId": "c@x", "enabled": True}))
  assert ("clear_sub", "c@x") in calls
  assert ("reset",) in calls


def test_invalidate_chat_settings_chat_invalidates_caches():
  calls = []
  router, *_ = _make(calls)
  asyncio.run(router.handle({"type": "invalidate_chat_settings", "chatId": "c@x"}))
  assert ("invalidate_chat", "c@x") in calls


def test_unknown_event_type_is_noop():
  calls = []
  router, per_chat, idle = _make(calls)
  asyncio.run(router.handle({"type": "incoming_message", "payload": {}}))
  asyncio.run(router.handle({"type": "error", "payload": "boom"}))
  # No cache/state effects for non-control events.
  assert calls == []
  assert len(per_chat) == 2
