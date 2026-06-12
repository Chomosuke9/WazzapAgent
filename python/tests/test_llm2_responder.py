"""Unit tests for :class:`bridge.agent.llm2_responder.Llm2Responder` (Step 09).

Constructs the responder with FAKE collaborators — a stand-in ``generate_reply``
(async) and fake action-extraction functions — so the generation passthrough
and the ``_validate_llm2_result`` behaviour are tested without any network /
LLM / DB. Uses ``asyncio.run`` so the tests are fast and never hang.

The validation behaviour must be byte-identical to the former
``_validate_llm2_result`` closure: prefer the tool-call extraction path, fall
back to text-content extraction, and return True iff at least one usable action
results.
"""
from __future__ import annotations

import asyncio

from bridge.agent.llm2_responder import Llm2Responder


class _FakeResult:
  def __init__(self, tool_calls=None):
    # ``getattr(result, 'tool_calls', None)`` is how the validator reads this.
    self.tool_calls = tool_calls or []


def _make(*, tool_actions=None, text_actions=None, gen_result="REPLY"):
  calls = {"tool": [], "text": [], "gen": []}

  def fake_extract_from_tool_calls(tool_calls, *, fallback_reply_to, allowed_context_ids):
    calls["tool"].append((tool_calls, fallback_reply_to, allowed_context_ids))
    return list(tool_actions or [])

  def fake_extract_actions(result, *, fallback_reply_to, allowed_context_ids):
    calls["text"].append((result, fallback_reply_to, allowed_context_ids))
    return list(text_actions or [])

  async def fake_generate_reply(history, current, **kwargs):
    calls["gen"].append((history, current, kwargs))
    return gen_result

  responder = Llm2Responder(
    generate_reply=fake_generate_reply,
    extract_actions_from_tool_calls=fake_extract_from_tool_calls,
    extract_actions=fake_extract_actions,
  )
  return responder, calls


def test_validate_uses_tool_call_path_when_tool_calls_present():
  responder, calls = _make(tool_actions=[{"type": "reply_message"}])
  result = _FakeResult(tool_calls=[{"name": "reply_message"}])
  ok = responder.validate_result(
    result, fallback_reply_to="000124", allowed_context_ids={"000124"}
  )
  assert ok is True
  # Tool-call path used; text fallback NOT used.
  assert len(calls["tool"]) == 1
  assert len(calls["text"]) == 0
  assert calls["tool"][0][1] == "000124"
  assert calls["tool"][0][2] == {"000124"}


def test_validate_tool_calls_present_but_no_usable_actions_is_false():
  responder, calls = _make(tool_actions=[])
  result = _FakeResult(tool_calls=[{"name": "noop"}])
  ok = responder.validate_result(
    result, fallback_reply_to=None, allowed_context_ids=set()
  )
  assert ok is False
  # When tool_calls are present, the validator does NOT fall through to text.
  assert len(calls["tool"]) == 1
  assert len(calls["text"]) == 0


def test_validate_falls_back_to_text_when_no_tool_calls():
  responder, calls = _make(text_actions=[{"type": "reply_message"}])
  result = _FakeResult(tool_calls=[])
  ok = responder.validate_result(
    result, fallback_reply_to=None, allowed_context_ids=set()
  )
  assert ok is True
  assert len(calls["tool"]) == 0
  assert len(calls["text"]) == 1


def test_validate_text_fallback_empty_is_false():
  responder, calls = _make(text_actions=[])
  result = _FakeResult(tool_calls=[])
  ok = responder.validate_result(
    result, fallback_reply_to=None, allowed_context_ids=set()
  )
  assert ok is False


def test_make_validator_closes_over_batch_locals():
  responder, calls = _make(tool_actions=[{"type": "reply_message"}])
  validator = responder.make_validator(
    fallback_reply_to="000130", allowed_context_ids={"000130", "000131"}
  )
  result = _FakeResult(tool_calls=[{"name": "reply_message"}])
  assert validator(result) is True
  assert calls["tool"][0][1] == "000130"
  assert calls["tool"][0][2] == {"000130", "000131"}


def test_generate_is_passthrough_and_forwards_kwargs():
  responder, calls = _make(gen_result="THE_REPLY")
  out = asyncio.run(
    responder.generate(
      ["hist"],
      "current",
      current_payload={"chatId": "x@g.us"},
      allow_subagent=True,
      result_validator=lambda r: True,
    )
  )
  assert out == "THE_REPLY"
  assert len(calls["gen"]) == 1
  history, current, kwargs = calls["gen"][0]
  assert history == ["hist"]
  assert current == "current"
  assert kwargs["current_payload"] == {"chatId": "x@g.us"}
  assert kwargs["allow_subagent"] is True
  assert callable(kwargs["result_validator"])


def test_defaults_wire_real_primitives():
  from bridge.llm.llm2 import generate_reply as real_generate_reply
  from bridge.messaging.actions import _extract_actions, _extract_actions_from_tool_calls

  responder = Llm2Responder()
  assert responder._generate_reply is real_generate_reply
  assert responder._extract_actions is _extract_actions
  assert responder._extract_actions_from_tool_calls is _extract_actions_from_tool_calls
