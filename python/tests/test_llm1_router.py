"""Unit tests for :class:`bridge.agent.llm1_router.Llm1Router` (Step 09).

Constructs the router with a FAKE ``call_llm1`` (an async stand-in returning a
canned :class:`LLM1Decision`) — no network, no LLM SDK. Asserts the router
forwards its arguments verbatim and returns the decision object unchanged. Uses
``asyncio.run`` so the tests are fast and never hang.
"""
from __future__ import annotations

import asyncio

from bridge.agent.llm1_router import Llm1Router
from bridge.llm.schemas import LLM1Decision


def test_route_forwards_args_and_returns_decision():
  captured = {}

  async def fake_call_llm1(history, current, *, current_payload=None,
                           group_description=None, prompt_override=None, **kw):
    captured["args"] = (history, current)
    captured["current_payload"] = current_payload
    captured["group_description"] = group_description
    captured["prompt_override"] = prompt_override
    captured["extra"] = kw
    return LLM1Decision(should_response=True, confidence=87, reason="respond now")

  router = Llm1Router(call_llm1=fake_call_llm1)
  decision = asyncio.run(
    router.route(
      ["h1", "h2"],
      "current-msg",
      current_payload={"chatId": "x@g.us"},
      group_description="desc",
      prompt_override="ovr",
    )
  )

  assert isinstance(decision, LLM1Decision)
  assert decision.should_response is True
  assert decision.confidence == 87
  assert decision.reason == "respond now"
  # Arguments forwarded verbatim.
  assert captured["args"] == (["h1", "h2"], "current-msg")
  assert captured["current_payload"] == {"chatId": "x@g.us"}
  assert captured["group_description"] == "desc"
  assert captured["prompt_override"] == "ovr"


def test_route_returns_express_decision_unchanged():
  async def fake_call_llm1(history, current, **kw):
    return LLM1Decision(
      should_response=False,
      confidence=42,
      reason="express only",
      react_expression="👍",
      react_context_msg_id="000125",
    )

  router = Llm1Router(call_llm1=fake_call_llm1)
  decision = asyncio.run(router.route([], "m"))

  assert decision.should_response is False
  assert decision.react_expression == "👍"
  assert decision.react_context_msg_id == "000125"
  assert decision.confidence == 42


def test_route_forwards_extra_kwargs():
  captured = {}

  async def fake_call_llm1(history, current, **kw):
    captured.update(kw)
    return LLM1Decision(should_response=False, confidence=10, reason="skip")

  router = Llm1Router(call_llm1=fake_call_llm1)
  asyncio.run(router.route([], "m", timeout=3.5))

  assert captured.get("timeout") == 3.5


def test_default_call_llm1_is_the_real_primitive():
  # Sanity: when no fake is injected, the router wraps llm.llm1.call_llm1.
  from bridge.llm.llm1 import call_llm1 as real_call_llm1

  router = Llm1Router()
  assert router._call_llm1 is real_call_llm1
