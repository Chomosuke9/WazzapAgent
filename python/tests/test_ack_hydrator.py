"""Step 10 — ``AckHydrator`` class-wrapper tests.

``handle_action_ack`` (the verbatim Step-29 logic) is exercised by
``test_hydration``; here we prove the per-account :class:`AckHydrator` wrapper
binds the session's pending-ack maps + history and delegates correctly, so the
provisional -> real ``contextMsgId`` hydration still happens when driven via the
class (the seam ``register()`` now uses).

Discipline: NO pytest-asyncio — driven with :func:`asyncio.run`; no socket.
"""
from __future__ import annotations

import asyncio
from collections import OrderedDict, defaultdict, deque

from bridge.agent.ack_hydrator import AckHydrator
from bridge.history import WhatsAppMessage
from wasocket.protocol import AckResult


def _hydrator():
  maps = dict(
    per_chat=defaultdict(deque),
    per_chat_lock=defaultdict(asyncio.Lock),
    pending_send_request_chat=OrderedDict(),
    pending_subagent_attachments=OrderedDict(),
    pending_run_command_chat=OrderedDict(),
    media_paths_by_chat=defaultdict(dict),
  )
  return AckHydrator(**maps), maps


def test_ack_hydrator_hydrates_provisional_send():
  hyd, maps = _hydrator()
  chat_id = "123@g.us"
  rid = "send-1715097600000-000001"
  history = maps["per_chat"][chat_id]
  history.append(WhatsAppMessage(
    timestamp_ms=1_700_000_000_000,
    sender="LLM",
    sender_ref="You",
    text="hello world",
    role="assistant",
    context_msg_id="pending",
    message_id=f"local-send-{rid}",
  ))
  maps["pending_send_request_chat"][rid] = chat_id

  ack = AckResult(
    request_id=rid,
    action="send_message",
    ok=True,
    detail="sent",
    result={"sent": [{"kind": "text", "contextMsgId": "000123"}]},
  )
  asyncio.run(hyd.handle(ack))

  assert history[0].context_msg_id == "000123"
  assert rid not in maps["pending_send_request_chat"]


def test_ack_hydrator_run_command_appends_history_line():
  hyd, maps = _hydrator()
  chat_id = "456@g.us"
  rid = "cmd-1"
  maps["pending_run_command_chat"][rid] = (chat_id, "/help")

  ack = AckResult(
    request_id=rid,
    action="run_command",
    ok=True,
    detail="executed",
    result={"command": "help"},
  )
  asyncio.run(hyd.handle(ack))

  history = maps["per_chat"][chat_id]
  assert len(history) == 1
  assert history[0].text == "Command help executed successfully"
