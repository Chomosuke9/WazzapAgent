"""Tests for LLM2 tool call extraction, permission levels, mute DB, and build_llm2_tools."""
from __future__ import annotations

import os
import sys
from pathlib import Path

# Ensure the bridge package is importable
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bridge.llm.tool_utils import extract_tool_args, get_tool_call_name
from bridge.llm.schemas import build_llm2_tools
from bridge.messaging.actions import _extract_actions_from_tool_calls
from bridge.db import (
  permission_allows_delete,
  permission_allows_mute,
  permission_allows_kick,
  permission_description,
)


# ---------------------------------------------------------------------------
# tool_utils
# ---------------------------------------------------------------------------

class TestExtractToolArgs:
  def test_dict_args(self):
    tc = {"args": {"text": "hello"}}
    assert extract_tool_args(tc) == {"text": "hello"}

  def test_dict_function_arguments(self):
    tc = {"function": {"arguments": '{"text": "hello"}'}}
    assert extract_tool_args(tc) == {"text": "hello"}

  def test_object_args(self):
    class TC:
      args = {"emoji": "👍"}
    assert extract_tool_args(TC()) == {"emoji": "👍"}

  def test_empty_returns_empty_dict(self):
    assert extract_tool_args({}) == {}

  def test_invalid_json_string(self):
    tc = {"args": "not json"}
    assert extract_tool_args(tc) == {}


class TestGetToolCallName:
  def test_dict_name(self):
    assert get_tool_call_name({"name": "reply_message"}) == "reply_message"

  def test_dict_function_name(self):
    assert get_tool_call_name({"function": {"name": "kick_members"}}) == "kick_members"

  def test_object_name(self):
    class TC:
      name = "react_to_message"
    assert get_tool_call_name(TC()) == "react_to_message"

  def test_none_for_empty(self):
    assert get_tool_call_name({}) is None


# ---------------------------------------------------------------------------
# build_llm2_tools
# ---------------------------------------------------------------------------

class TestBuildLlm2Tools:
  def test_base_only(self):
    tools = build_llm2_tools()
    names = [t["function"]["name"] for t in tools]
    assert names == ["reply_message", "react_to_message", "send_sticker", "send_quiz"]

  def test_delete_adds_delete(self):
    tools = build_llm2_tools(allow_delete=True)
    names = [t["function"]["name"] for t in tools]
    assert "delete_messages" in names
    assert "mute_member" not in names
    assert "kick_members" not in names

  def test_mute_adds_mute(self):
    tools = build_llm2_tools(allow_mute=True)
    names = [t["function"]["name"] for t in tools]
    assert "mute_member" in names

  def test_kick_adds_kick(self):
    tools = build_llm2_tools(allow_kick=True)
    names = [t["function"]["name"] for t in tools]
    assert "kick_members" in names

  def test_all_permissions(self):
    tools = build_llm2_tools(allow_delete=True, allow_mute=True, allow_kick=True)
    names = [t["function"]["name"] for t in tools]
    assert len(names) == 7
    assert "delete_messages" in names
    assert "mute_member" in names
    assert "kick_members" in names

  def test_permission_level_0(self):
    """Level 0: no moderation tools."""
    tools = build_llm2_tools(
      allow_delete=permission_allows_delete(0),
      allow_mute=permission_allows_mute(0),
      allow_kick=permission_allows_kick(0),
    )
    assert len(tools) == 4

  def test_permission_level_1(self):
    """Level 1: delete only."""
    tools = build_llm2_tools(
      allow_delete=permission_allows_delete(1),
      allow_mute=permission_allows_mute(1),
      allow_kick=permission_allows_kick(1),
    )
    names = [t["function"]["name"] for t in tools]
    assert "delete_messages" in names
    assert "mute_member" not in names
    assert "kick_members" not in names

  def test_permission_level_2(self):
    """Level 2: delete + mute."""
    tools = build_llm2_tools(
      allow_delete=permission_allows_delete(2),
      allow_mute=permission_allows_mute(2),
      allow_kick=permission_allows_kick(2),
    )
    names = [t["function"]["name"] for t in tools]
    assert "delete_messages" in names
    assert "mute_member" in names
    assert "kick_members" not in names

  def test_permission_level_3(self):
    """Level 3: delete + mute + kick."""
    tools = build_llm2_tools(
      allow_delete=permission_allows_delete(3),
      allow_mute=permission_allows_mute(3),
      allow_kick=permission_allows_kick(3),
    )
    names = [t["function"]["name"] for t in tools]
    assert "delete_messages" in names
    assert "mute_member" in names
    assert "kick_members" in names


# ---------------------------------------------------------------------------
# Permission level functions (progressive)
# ---------------------------------------------------------------------------

class TestPermissionLevels:
  def test_level_0(self):
    assert not permission_allows_delete(0)
    assert not permission_allows_mute(0)
    assert not permission_allows_kick(0)

  def test_level_1(self):
    assert permission_allows_delete(1)
    assert not permission_allows_mute(1)
    assert not permission_allows_kick(1)

  def test_level_2(self):
    assert permission_allows_delete(2)
    assert permission_allows_mute(2)
    assert not permission_allows_kick(2)

  def test_level_3(self):
    assert permission_allows_delete(3)
    assert permission_allows_mute(3)
    assert permission_allows_kick(3)

  def test_descriptions(self):
    assert "FORBIDDEN" in permission_description(0)
    assert "delete ALLOWED" in permission_description(1)
    assert "mute ALLOWED" in permission_description(2)
    assert "kick ALLOWED" in permission_description(3)


# ---------------------------------------------------------------------------
# _extract_actions_from_tool_calls
# ---------------------------------------------------------------------------

class TestExtractActionsFromToolCalls:
  def test_execute_subtask_dedupes_known_file_context_ids(self):
    tc = [{"name": "execute_subtask", "args": {
      "instruction": "inspect both",
      "confirmation_text": "Inspecting now",
      "context_msg_ids": ["000123", "000123", "000124"],
      "high_quality": False,
    }}]
    actions = _extract_actions_from_tool_calls(
      tc,
      fallback_reply_to=None,
      allowed_context_ids={"000123", "000124"},
    )
    delegated = [a for a in actions if a["type"] == "execute_subtask"]
    assert delegated[0]["contextMsgIds"] == ["000123", "000124"]

  def test_execute_subtask_rejects_unavailable_id_and_confirmation_together(self):
    tc = [{"name": "execute_subtask", "args": {
      "instruction": "inspect",
      "confirmation_text": "Inspecting now",
      "context_msg_ids": ["999999"],
      "high_quality": False,
    }}]
    actions = _extract_actions_from_tool_calls(
      tc,
      fallback_reply_to="000123",
      allowed_context_ids={"000123"},
    )
    assert actions == []

  def test_reply_message(self):
    tc = [{"name": "reply_message", "args": {"context_msg_id": "000123", "text": "Hello!"}}]
    actions = _extract_actions_from_tool_calls(
      tc, fallback_reply_to=None, allowed_context_ids={"000123"},
    )
    assert len(actions) == 1
    assert actions[0]["type"] == "send_message"
    assert actions[0]["text"] == "Hello!"
    assert actions[0]["replyTo"] == "000123"

  def test_reply_none_target(self):
    tc = [{"name": "reply_message", "args": {"context_msg_id": "none", "text": "Hi"}}]
    actions = _extract_actions_from_tool_calls(
      tc, fallback_reply_to="000100", allowed_context_ids=set(),
    )
    assert len(actions) == 1
    assert actions[0]["replyTo"] is None

  def test_reply_command_literal_null_string_ignored(self):
    # Some models emit the literal string "null" instead of a JSON null for
    # the optional command. It must NOT be treated as a real slash command.
    for sentinel in ("null", "NULL", "none", "None", "nil", "/"):
      tc = [{"name": "reply_message", "args": {
        "context_msg_id": "000123",
        "text": "Hi",
        "command": sentinel,
        "command_context_msg_id": None,
      }}]
      actions = _extract_actions_from_tool_calls(
        tc, fallback_reply_to=None, allowed_context_ids={"000123"},
      )
      # Only the send_message action — no run_command for the sentinel.
      assert len(actions) == 1, f"sentinel {sentinel!r} should yield no run_command"
      assert actions[0]["type"] == "send_message"

  def test_reply_command_without_slash_is_normalized(self):
    # Loosened requirement: a command with no leading '/' is accepted and
    # normalized by prepending '/' rather than being rejected.
    tc = [{"name": "reply_message", "args": {
      "context_msg_id": "000123",
      "text": "Making it a sticker",
      "command": "sticker upper#lower",
      "command_context_msg_id": "000123",
    }}]
    actions = _extract_actions_from_tool_calls(
      tc, fallback_reply_to=None, allowed_context_ids={"000123"},
    )
    assert len(actions) == 2
    run_cmd = next(a for a in actions if a["type"] == "run_command")
    assert run_cmd["command"] == "/sticker upper#lower"
    assert run_cmd["contextMsgId"] == "000123"

  def test_reply_command_with_slash_unchanged(self):
    tc = [{"name": "reply_message", "args": {
      "context_msg_id": "000123",
      "text": "On it",
      "command": "/help",
      "command_context_msg_id": "000123",
    }}]
    actions = _extract_actions_from_tool_calls(
      tc, fallback_reply_to=None, allowed_context_ids={"000123"},
    )
    run_cmd = next(a for a in actions if a["type"] == "run_command")
    assert run_cmd["command"] == "/help"

  def test_react_to_message(self):
    tc = [{"name": "react_to_message", "args": {"context_msg_id": "000123", "emoji": "👍"}}]
    actions = _extract_actions_from_tool_calls(
      tc, fallback_reply_to=None, allowed_context_ids={"000123"},
    )
    assert len(actions) == 1
    assert actions[0]["type"] == "react_message"
    assert actions[0]["emoji"] == "👍"

  def test_send_sticker(self):
    tc = [{"name": "send_sticker", "args": {"context_msg_id": "000123", "sticker_name": "laughing"}}]
    actions = _extract_actions_from_tool_calls(
      tc, fallback_reply_to=None, allowed_context_ids={"000123"},
    )
    assert len(actions) == 1
    assert actions[0]["type"] == "send_sticker"
    assert actions[0]["stickerName"] == "laughing"

  def test_delete_messages(self):
    tc = [{"name": "delete_messages", "args": {"context_msg_ids": ["000123", "000124"]}}]
    actions = _extract_actions_from_tool_calls(
      tc, fallback_reply_to=None, allowed_context_ids={"000123", "000124"},
    )
    assert len(actions) == 2
    assert all(a["type"] == "delete_message" for a in actions)

  def test_delete_deduplicates(self):
    tc = [{"name": "delete_messages", "args": {"context_msg_ids": ["000123", "000123"]}}]
    actions = _extract_actions_from_tool_calls(
      tc, fallback_reply_to=None, allowed_context_ids={"000123"},
    )
    assert len(actions) == 1

  def test_kick_members(self):
    tc = [{"name": "kick_members", "args": {"targets": [
      {"sender_ref": "u8k2d1"},
    ]}}]
    actions = _extract_actions_from_tool_calls(
      tc, fallback_reply_to=None, allowed_context_ids={"000123"},
    )
    assert len(actions) == 1
    assert actions[0]["type"] == "kick_member"
    assert actions[0]["targets"][0]["senderRef"] == "u8k2d1"
    assert "anchorContextMsgId" not in actions[0]["targets"][0]
    assert "autoReplyAnchor" not in actions[0]

  def test_mute_member(self):
    tc = [{"name": "mute_member", "args": {
      "sender_ref": "u8k2d1",
      "duration_minutes": 30,
    }}]
    actions = _extract_actions_from_tool_calls(
      tc, fallback_reply_to=None, allowed_context_ids={"000123"},
    )
    assert len(actions) == 1
    assert actions[0]["type"] == "mute_member"
    assert actions[0]["senderRef"] == "u8k2d1"
    assert actions[0]["durationMinutes"] == 30
    assert "anchorContextMsgId" not in actions[0]

  def test_mute_clamps_duration(self):
    tc = [{"name": "mute_member", "args": {
      "sender_ref": "u8k2d1",
      "duration_minutes": 9999,
    }}]
    actions = _extract_actions_from_tool_calls(
      tc, fallback_reply_to=None, allowed_context_ids={"000123"},
    )
    assert actions[0]["durationMinutes"] == 1440

  def test_empty_tool_calls(self):
    assert _extract_actions_from_tool_calls(
      [], fallback_reply_to=None, allowed_context_ids=set(),
    ) == []

  def test_unknown_tool_ignored(self):
    tc = [{"name": "unknown_tool", "args": {}}]
    actions = _extract_actions_from_tool_calls(
      tc, fallback_reply_to=None, allowed_context_ids=set(),
    )
    assert len(actions) == 0

  def test_multiple_tool_calls(self):
    tc = [
      {"name": "reply_message", "args": {"context_msg_id": "000123", "text": "Warned."}},
      {"name": "react_to_message", "args": {"context_msg_id": "000123", "emoji": "⚠️"}},
      {"name": "delete_messages", "args": {"context_msg_ids": ["000124"]}},
    ]
    actions = _extract_actions_from_tool_calls(
      tc, fallback_reply_to=None, allowed_context_ids={"000123", "000124"},
    )
    assert len(actions) == 3
    types = [a["type"] for a in actions]
    assert "send_message" in types
    assert "react_message" in types
    assert "delete_message" in types

  def test_invalid_context_id_filtered(self):
    tc = [{"name": "react_to_message", "args": {"context_msg_id": "bad", "emoji": "👍"}}]
    actions = _extract_actions_from_tool_calls(
      tc, fallback_reply_to=None, allowed_context_ids=set(),
    )
    assert len(actions) == 0


# ---------------------------------------------------------------------------
# Mute DB functions
# ---------------------------------------------------------------------------

class TestMuteDB:
  """Test mute DB functions using a temporary in-memory override."""

  def setup_method(self):
    """Set up a temporary DB for each test."""
    import tempfile
    self._tmpdir = tempfile.mkdtemp()
    os.environ["BOT_DB_PATH"] = os.path.join(self._tmpdir, "test.db")
    # Reset DB state
    from bridge import db
    db._DB_PATH = None
    db._mute_cache.clear()
    db._LOCAL = type(db._LOCAL)()

  def teardown_method(self):
    import shutil
    shutil.rmtree(self._tmpdir, ignore_errors=True)
    os.environ.pop("BOT_DB_PATH", None)
    from bridge import db
    db._DB_PATH = None

  def test_add_and_check_mute(self):
    from bridge.db import add_mute, is_muted
    add_mute("chat1", "u1abc", 30)
    assert is_muted("chat1", "u1abc") is True
    assert is_muted("chat1", "u2xyz") is False

  def test_mute_expiry(self):
    from bridge.db import add_mute, is_muted, _mute_cache, _cache_lock, _tenant_cache_key
    add_mute("chat1", "u1abc", 1)
    # Manually set muted_at to a time far in the past so it's expired.
    # The mute cache is tenant-scoped: outer key is (tenant, chat_id).
    with _cache_lock:
      _mute_cache[_tenant_cache_key("chat1")]["u1abc"]["muted_at"] = "2020-01-01 00:00:00"
    assert is_muted("chat1", "u1abc") is False

  def test_clear_mutes(self):
    from bridge.db import add_mute, is_muted, clear_mutes
    add_mute("chat1", "u1abc", 30)
    add_mute("chat1", "u2xyz", 30)
    clear_mutes("chat1")
    assert is_muted("chat1", "u1abc") is False
    assert is_muted("chat1", "u2xyz") is False

  def test_notification_tracking(self):
    from bridge.db import add_mute, is_mute_notified, mark_mute_notified
    add_mute("chat1", "u1abc", 30)
    assert is_mute_notified("chat1", "u1abc") is False
    mark_mute_notified("chat1", "u1abc")
    assert is_mute_notified("chat1", "u1abc") is True

  def test_remaining_minutes(self):
    from bridge.db import add_mute, get_mute_remaining_minutes
    add_mute("chat1", "u1abc", 60)
    remaining = get_mute_remaining_minutes("chat1", "u1abc")
    assert 58 <= remaining <= 60

  def test_add_mute_stores_sender_name(self):
    from bridge.db import add_mute, list_active_mutes
    add_mute("chatname", "u1abc", 30, sender_name="Alice")
    mutes = list_active_mutes("chatname")
    by_ref = {m["sender_ref"]: m for m in mutes}
    assert by_ref["u1abc"]["name"] == "Alice"

  def test_add_mute_without_name_keeps_none(self):
    from bridge.db import add_mute, list_active_mutes
    add_mute("chatnoname", "u2def", 30)
    mutes = list_active_mutes("chatnoname")
    by_ref = {m["sender_ref"]: m for m in mutes}
    assert by_ref["u2def"]["name"] is None

  def test_remute_without_name_preserves_existing_name(self):
    from bridge.db import add_mute, list_active_mutes
    add_mute("chatkeep", "u3ghi", 30, sender_name="Bob")
    # Re-mute with no name should not wipe the stored name.
    add_mute("chatkeep", "u3ghi", 10)
    by_ref = {m["sender_ref"]: m for m in list_active_mutes("chatkeep")}
    assert by_ref["u3ghi"]["name"] == "Bob"

  def test_list_active_mutes_excludes_unmuted(self):
    from bridge.db import add_mute, remove_mute, list_active_mutes
    add_mute("chatlist", "active1", 30, sender_name="Active")
    add_mute("chatlist", "tounmute", 30, sender_name="Gone")
    # Unmute one (the duration=0 dispatch path calls remove_mute).
    remove_mute("chatlist", "tounmute")
    refs = {m["sender_ref"] for m in list_active_mutes("chatlist")}
    assert refs == {"active1"}

  def test_list_active_mutes_drops_expired_db_rows(self):
    from bridge.db import add_mute, list_active_mutes, _get_moderation_conn
    add_mute("chatexp", "stale1", 30, sender_name="Stale")
    add_mute("chatexp", "fresh1", 30, sender_name="Fresh")
    # Backdate the DB row + duration so it is genuinely expired on disk.
    conn = _get_moderation_conn()
    conn.execute(
      "UPDATE chat_mutes SET muted_at = '2020-01-01 00:00:00', duration_m = 1 "
      "WHERE chat_id = ? AND sender_ref = ?",
      ("chatexp", "stale1"),
    )
    conn.commit()
    refs = {m["sender_ref"] for m in list_active_mutes("chatexp")}
    assert refs == {"fresh1"}

  def test_list_active_mutes_empty_when_none(self):
    from bridge.db import list_active_mutes
    assert list_active_mutes("chatempty") == []
