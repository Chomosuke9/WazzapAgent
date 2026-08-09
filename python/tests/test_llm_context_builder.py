from __future__ import annotations

import asyncio

from bridge.agent.llm_context_builder import LlmContextBuilder


class _LiveWs:
  def __init__(self, result=None, error: Exception | None = None):
    self.result = result
    self.error = error
    self.calls = []

  async def get_chat_context(self, chat_id, *, force_refresh=False):
    self.calls.append((chat_id, force_refresh))
    if self.error is not None:
      raise self.error
    return self.result


def test_builder_overlays_live_group_snapshot_and_shared_prompt_inputs():
  async def scenario():
    ws = _LiveWs({
      "chatId": "group@g.us",
      "chatName": "Operators",
      "chatType": "group",
      "isGroup": True,
      "groupDescription": "Production operations",
      "botIsAdmin": True,
      "botIsSuperAdmin": False,
    })
    builder = LlmContextBuilder(
      ws=ws,
      get_prompt=lambda _chat_id: "Use concise answers",
      memory_builder=lambda _chat_id: "## Memory\ntrusted fact",
    )

    context = await builder.build(
      "group@g.us",
      {
        "botIsAdmin": False,
        "chatName": "stale",
        "senderId": "admin@s.whatsapp.net",
        "contextMsgId": "000123",
        "fromMe": False,
      },
      refresh_live=True,
    )

    assert ws.calls == [("group@g.us", True)]
    assert context.current_payload["chatName"] == "Operators"
    assert context.group_description == "Production operations"
    assert context.bot_is_admin is True
    assert context.bot_is_super_admin is False
    assert context.prompt_override == "Use concise answers"
    assert context.memory_block == "## Memory\ntrusted fact"

  asyncio.run(scenario())


def test_builder_live_lookup_failure_falls_back_without_fabricating_admin():
  async def scenario():
    builder = LlmContextBuilder(
      ws=_LiveWs(error=RuntimeError("offline")),
      memory_builder=lambda _chat_id: None,
    )
    context = await builder.build("group@g.us", refresh_live=True)
    assert context.chat_type == "group"
    assert context.bot_is_admin is False
    assert context.bot_is_super_admin is False

  asyncio.run(scenario())
