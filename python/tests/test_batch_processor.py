"""Step 10 — ``BatchProcessor`` pipeline decision-point tests.

Exercises the extracted :class:`bridge.agent.batch_processor.BatchProcessor`
seam directly (via a real :class:`AgentSession` over a stub ``WaSocket``) for the
LLM-free decision points of ``process_message_batch``:

  * an empty / no-meaningful-content batch returns early (no history mutation);
  * a context-only batch (no LLM1 trigger) is appended to per-chat history and
    NEITHER LLM1 nor LLM2 is invoked.

These prove the batch orchestrator's branching is preserved without needing a
live LLM/socket. Discipline: NO pytest-asyncio — driven with :func:`asyncio.run`;
the LLM collaborators are replaced with tripwires that fail if reached.
"""
from __future__ import annotations

import asyncio

from bridge.session import AgentSession


class StubWaSocket:
  def __init__(self, folder_path: str) -> None:
    self._folder_path = folder_path
    self.handlers: dict[str, list] = {}

  @property
  def folder_path(self) -> str:
    return self._folder_path

  def on(self, event: str):
    def deco(h):
      self.handlers.setdefault(event, []).append(h)
      return h
    return deco


def _ctx_only_payload(chat_id: str, text: str) -> dict:
  return {
    "chatId": chat_id,
    "chatType": "private",
    "senderRef": "",
    "contextOnly": True,
    "triggerLlm1": False,
    "messageType": "conversation",
    "text": text,
    "timestampMs": 1_700_000_000_000,
  }


def _arm_llm_tripwires(session):
  async def _boom(*a, **k):
    raise AssertionError("LLM must not be called on the context-only fast path")
  session._llm1.route = _boom        # type: ignore[assignment]
  session._llm2.generate = _boom     # type: ignore[assignment]


def test_empty_batch_is_noop():
  session = AgentSession(StubWaSocket("/a"))
  _arm_llm_tripwires(session)
  asyncio.run(session._batch.process_message_batch([]))
  assert len(session.per_chat) == 0


def test_no_meaningful_content_batch_returns_early():
  session = AgentSession(StubWaSocket("/a"))
  _arm_llm_tripwires(session)
  payload = {
    "chatId": "c@x",
    "chatType": "private",
    "senderRef": "",
    "messageType": "conversation",
    "text": "",
    "timestampMs": 1_700_000_000_000,
  }
  asyncio.run(session._batch.process_message_batch([payload]))
  assert "c@x" not in session.per_chat


def test_context_only_batch_appends_history_without_llm():
  session = AgentSession(StubWaSocket("/a"))
  _arm_llm_tripwires(session)
  chat_id = "c@x"
  asyncio.run(session._batch.process_message_batch([
    _ctx_only_payload(chat_id, "one"),
    _ctx_only_payload(chat_id, "two"),
  ]))
  texts = [m.text for m in session.per_chat[chat_id]]
  assert texts == ["one", "two"]


def test_context_only_batch_is_isolated_per_session():
  sess_a = AgentSession(StubWaSocket("/a"))
  sess_b = AgentSession(StubWaSocket("/b"))
  _arm_llm_tripwires(sess_a)
  _arm_llm_tripwires(sess_b)
  asyncio.run(sess_a._batch.process_message_batch([_ctx_only_payload("c@x", "A")]))
  assert [m.text for m in sess_a.per_chat["c@x"]] == ["A"]
  assert "c@x" not in sess_b.per_chat
