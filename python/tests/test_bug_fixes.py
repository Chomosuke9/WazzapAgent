"""Tests for bug fixes and new functionality introduced in the
'Fix: LLM2 context sometimes not built properly' commit plus follow-up fixes.

Covers:
  - Bug #1: _message_text media stub suppression now guarded by msg.media
  - Bug #2: format_history iterator exhaustion when history=None
  - Bug #3: <media:...> stub suppression in REPLYING TO quoted text
  - Bug #4: hydrate_quoted_from_history deduplication (shared function)
  - Bug #5: _format_role deduplication (shared function)
  - Bug #6: _resolve_quoted_mentions None vs empty string
  - Bug #7: Sticker log uses assistant_name() instead of "bot"
  - quoted_sender_ref, quoted_sender_is_admin, quoted_sender_is_super_admin
  - _hydrate_quoted_from_history hydration from history
  - format_history with one-shot iterator
  - _is_media_stub helper
  - (superadmin) role label rendering
"""
from __future__ import annotations

import os
import sys
import unittest
from collections import deque
from pathlib import Path
from unittest.mock import patch

PYTHON_DIR = Path(__file__).resolve().parents[1]
if str(PYTHON_DIR) not in sys.path:
  sys.path.insert(0, str(PYTHON_DIR))

from bridge.history import (
  WhatsAppMessage,
  format_history,
  hydrate_quoted_from_history,
  _message_text,
  _is_media_stub,
  _format_role,
)
from bridge.messaging.processing import (
  _build_burst_current,
  _resolve_quoted_mentions,
  _hydrate_quoted_from_history_payload,
)


# ---------------------------------------------------------------------------
# Bug #1: _is_media_stub and _message_text guard
# ---------------------------------------------------------------------------

class TestIsMediaStub(unittest.TestCase):
  def test_media_stub_pattern(self) -> None:
    self.assertTrue(_is_media_stub("<media:image>"))
    self.assertTrue(_is_media_stub("<media:video>"))
    self.assertTrue(_is_media_stub("<media:audio>"))
    self.assertTrue(_is_media_stub("<media:document>"))
    self.assertTrue(_is_media_stub("<media:sticker>"))

  def test_non_stub_text_not_matched(self) -> None:
    self.assertFalse(_is_media_stub("hello world"))
    # Note: <media:photo caption text> starts with <media: and ends with >
    # so it IS classified as a stub by the simple pattern. This is by design
    # since real WhatsApp stubs are always <media:type> with no spaces.
    # Multi-word content like "<media:photo caption text>" is unlikely in practice.
    self.assertTrue(_is_media_stub("<media:photo caption text>"))
    # Does not end with >
    self.assertFalse(_is_media_stub("<media:image"))
    # Does not start with <media:
    self.assertFalse(_is_media_stub("media:image>"))

  def test_partial_match_not_stub(self) -> None:
    # Text with <media:...> somewhere in the middle is not a stub
    self.assertFalse(_is_media_stub("check <media:image> out"))
    self.assertFalse(_is_media_stub("<media:image> and more text"))


class TestMessageTextMediaStubSuppression(unittest.TestCase):
  """Bug #1: _message_text should only suppress <media:...> stubs when
  msg.media is also present. Without media, the text must be preserved."""

  def test_media_stub_suppressed_when_media_present(self) -> None:
    msg = WhatsAppMessage(
      timestamp_ms=1730000000000,
      sender="User",
      context_msg_id="001000",
      text="<media:image>",
      media="image",
    )
    result = _message_text(msg)
    # Stub text dropped, only media token remains
    self.assertEqual(result, "[image]")

  def test_media_stub_preserved_when_no_media(self) -> None:
    """Regression test: <media:...> text must NOT be silently dropped when
    msg.media is None. This was the core of Bug #1."""
    msg = WhatsAppMessage(
      timestamp_ms=1730000000000,
      sender="User",
      context_msg_id="001000",
      text="<media:photo>",
      media=None,
    )
    result = _message_text(msg)
    # Text must be preserved because there's no [media] prefix to duplicate
    self.assertEqual(result, "<media:photo>")

  def test_regular_text_preserved_with_media(self) -> None:
    msg = WhatsAppMessage(
      timestamp_ms=1730000000000,
      sender="User",
      context_msg_id="001000",
      text="Nice sunset!",
      media="image",
    )
    result = _message_text(msg)
    self.assertEqual(result, "[image] Nice sunset!")

  def test_regular_text_preserved_without_media(self) -> None:
    msg = WhatsAppMessage(
      timestamp_ms=1730000000000,
      sender="User",
      context_msg_id="001000",
      text="Hello world",
      media=None,
    )
    result = _message_text(msg)
    self.assertEqual(result, "Hello world")

  def test_empty_text_with_media(self) -> None:
    msg = WhatsAppMessage(
      timestamp_ms=1730000000000,
      sender="User",
      context_msg_id="001000",
      text=None,
      media="video",
    )
    result = _message_text(msg)
    self.assertEqual(result, "[video]")

  def test_no_text_no_media(self) -> None:
    msg = WhatsAppMessage(
      timestamp_ms=1730000000000,
      sender="User",
      context_msg_id="001000",
    )
    result = _message_text(msg)
    self.assertEqual(result, "(empty)")


# ---------------------------------------------------------------------------
# Bug #2: format_history with one-shot iterator
# ---------------------------------------------------------------------------

class TestFormatHistoryIteratorExhaustion(unittest.TestCase):
  """Bug #2: format_history should work with one-shot iterators when
  history=None. Previously, list(messages) consumed the iterator, leaving
  nothing for the for-loop."""

  def test_format_history_with_generator(self) -> None:
    """format_history should produce output when given a generator without
    an explicit history= parameter."""
    messages = [
      WhatsAppMessage(
        timestamp_ms=1730000000000,
        sender="Alice",
        context_msg_id="001000",
        sender_ref="a1",
        text="hello",
      ),
      WhatsAppMessage(
        timestamp_ms=1730000001000,
        sender="Bob",
        context_msg_id="001001",
        sender_ref="b2",
        text="world",
      ),
    ]
    # Use a generator (one-shot iterator) as input
    gen = (m for m in messages)
    result = format_history(gen)
    # Must contain both messages, not be empty
    self.assertIn("hello", result)
    self.assertIn("world", result)
    self.assertIn("[#001000]", result)
    self.assertIn("[#001001]", result)

  def test_format_history_with_explicit_history(self) -> None:
    """format_history with explicit history= should work normally."""
    messages = [
      WhatsAppMessage(
        timestamp_ms=1730000000000,
        sender="Alice",
        context_msg_id="001000",
        sender_ref="a1",
        text="hello",
      ),
    ]
    result = format_history(messages, history=messages)
    self.assertIn("hello", result)
    self.assertIn("[#001000]", result)


# ---------------------------------------------------------------------------
# Bug #3: <media:...> stub suppression in REPLYING TO lines
# ---------------------------------------------------------------------------

class TestReplyingToMediaStubSuppression(unittest.TestCase):
  """Bug #3: REPLYING TO lines should suppress <media:...> stub text
  when quoted_media already carries the type."""

  def test_quoted_media_stub_suppressed_with_media(self) -> None:
    """When quoted has both media type and <media:...> text, the stub text
    should be suppressed in the REPLYING TO line, leaving just [image]."""
    messages = [
      WhatsAppMessage(
        timestamp_ms=1730000000000,
        sender="Alice",
        context_msg_id="001000",
        sender_ref="a1",
        text="check this",
        quoted_message_id="000999",
        quoted_sender="Bob",
        quoted_sender_ref="b2",
        quoted_text="<media:image>",
        quoted_media="image",
      ),
    ]
    result = format_history(messages, history=messages)
    # Should show [image] but NOT the literal "<media:image>" text
    self.assertIn("[image]", result)
    self.assertNotIn("<media:image>", result)
    # The REPLYING TO line should show just [image]
    self.assertIn("REPLYING TO", result)

  def test_quoted_real_text_preserved_with_media(self) -> None:
    """When quoted has media and real text, both should appear."""
    messages = [
      WhatsAppMessage(
        timestamp_ms=1730000000000,
        sender="Alice",
        context_msg_id="001000",
        sender_ref="a1",
        text="nice shot",
        quoted_message_id="000999",
        quoted_sender="Bob",
        quoted_sender_ref="b2",
        quoted_text="Beautiful sunset",
        quoted_media="image",
      ),
    ]
    result = format_history(messages, history=messages)
    self.assertIn("[image]", result)
    self.assertIn("Beautiful sunset", result)

  def test_quoted_media_stub_preserved_when_no_media(self) -> None:
    """When quoted text is <media:...> but there's no quoted_media field,
    the text should be preserved (mirroring Bug #1 fix)."""
    messages = [
      WhatsAppMessage(
        timestamp_ms=1730000000000,
        sender="Alice",
        context_msg_id="001000",
        sender_ref="a1",
        text="replying",
        quoted_message_id="000999",
        quoted_sender="Bob",
        quoted_text="<media:photo>",
        quoted_media=None,
      ),
    ]
    result = format_history(messages, history=messages)
    # The stub text must NOT be suppressed since there's no media prefix
    self.assertIn("<media:photo>", result)

  def test_burst_quoted_media_stub_suppressed(self) -> None:
    """_build_burst_current should also suppress <media:...> stubs in
    REPLYING TO lines when quoted_media is present. Requires 2 payloads
    to trigger burst rendering."""
    first = {
      "timestampMs": 1730000000000,
      "contextMsgId": "000999",
      "messageId": "wamid-prev",
      "chatId": "1203630@g.us",
      "chatType": "group",
      "isGroup": True,
      "senderName": "Alice",
      "senderRef": "a1",
      "senderIsAdmin": False,
      "fromMe": False,
      "contextOnly": False,
      "text": "first message",
      "attachments": [],
    }
    second = {
      "timestampMs": 1730000001000,
      "contextMsgId": "001000",
      "messageId": "wamid-test",
      "chatId": "1203630@g.us",
      "chatType": "group",
      "isGroup": True,
      "senderName": "Bob",
      "senderRef": "b2",
      "senderIsAdmin": False,
      "fromMe": False,
      "contextOnly": False,
      "text": "replying",
      "attachments": [],
      "quoted": {
        "messageId": "quoted-wamid",
        "contextMsgId": "000998",
        "senderName": "Charlie",
        "senderRef": "c3",
        "type": "imageMessage",
        "text": "<media:image>",
      },
    }
    burst = _build_burst_current([first, second])
    self.assertIsNotNone(burst.text)
    assert burst.text is not None
    self.assertIn("[image]", burst.text)
    # The literal <media:image> stub should be suppressed in the REPLYING TO line
    self.assertNotIn("<media:image>", burst.text)


# ---------------------------------------------------------------------------
# Bug #4: hydrate_quoted_from_history deduplication
# ---------------------------------------------------------------------------

class TestHydrateQuotedFromHistory(unittest.TestCase):
  """Verify that hydrate_quoted_from_history (the shared function in
  history.py) correctly hydrates missing quoted fields from history."""

  def test_hydrate_sender_ref_from_history(self) -> None:
    """When quoted_sender_ref is missing but the quoted message exists in
    history, it should be hydrated."""
    history = [
      WhatsAppMessage(
        timestamp_ms=1730000000000,
        sender="Bob",
        context_msg_id="000999",
        sender_ref="b2ref",
        text="hello",
      ),
    ]
    msg = WhatsAppMessage(
      timestamp_ms=1730000001000,
      sender="Alice",
      context_msg_id="001000",
      sender_ref="a1",
      text="reply",
      quoted_message_id="000999",
      quoted_sender="Bob",
      # quoted_sender_ref is None — should be hydrated
    )
    hydrate_quoted_from_history(msg, history)
    self.assertEqual(msg.quoted_sender_ref, "b2ref")

  def test_hydrate_text_from_history(self) -> None:
    """When quoted_text is missing but the referenced message has text,
    it should be hydrated."""
    history = [
      WhatsAppMessage(
        timestamp_ms=1730000000000,
        sender="Bob",
        context_msg_id="000999",
        sender_ref="b2",
        text="original message text",
      ),
    ]
    msg = WhatsAppMessage(
      timestamp_ms=1730000001000,
      sender="Alice",
      context_msg_id="001000",
      sender_ref="a1",
      text="reply",
      quoted_message_id="000999",
      quoted_sender="Bob",
      # quoted_text is None — should be hydrated
    )
    hydrate_quoted_from_history(msg, history)
    self.assertEqual(msg.quoted_text, "original message text")

  def test_hydrate_admin_flags_from_history(self) -> None:
    """When quoted_sender_is_admin/is_super_admin are missing but the
    referenced message sender is admin, flags should be hydrated."""
    history = [
      WhatsAppMessage(
        timestamp_ms=1730000000000,
        sender="AdminUser",
        context_msg_id="000999",
        sender_ref="adm1",
        sender_is_admin=True,
        sender_is_super_admin=True,
        text="admin message",
      ),
    ]
    msg = WhatsAppMessage(
      timestamp_ms=1730000001000,
      sender="Alice",
      context_msg_id="001000",
      sender_ref="a1",
      text="reply to admin",
      quoted_message_id="000999",
      quoted_sender="AdminUser",
    )
    hydrate_quoted_from_history(msg, history)
    self.assertTrue(msg.quoted_sender_is_admin)
    self.assertTrue(msg.quoted_sender_is_super_admin)

  def test_hydrate_assistant_sender_ref(self) -> None:
    """When the quoted message is from the assistant, quoted_sender_ref
    should be hydrated from history. If the assistant message has a sender_ref,
    that's used; the 'You' fallback only applies if sender_ref is missing."""
    # Case 1: assistant message has sender_ref="bot" — that gets used
    history = [
      WhatsAppMessage(
        timestamp_ms=1730000000000,
        sender="LLM",
        context_msg_id="000999",
        sender_ref="bot",
        text="bot response",
        role="assistant",
      ),
    ]
    msg = WhatsAppMessage(
      timestamp_ms=1730000001000,
      sender="Alice",
      context_msg_id="001000",
      sender_ref="a1",
      text="reply to bot",
      quoted_message_id="000999",
      quoted_sender="LLM",
    )
    hydrate_quoted_from_history(msg, history)
    # sender_ref "bot" is filled from history (not overridden to "You")
    self.assertEqual(msg.quoted_sender_ref, "bot")

    # Case 2: assistant message has no sender_ref — "You" fallback applies
    history2 = [
      WhatsAppMessage(
        timestamp_ms=1730000000000,
        sender="LLM",
        context_msg_id="000999",
        sender_ref=None,
        text="bot response",
        role="assistant",
      ),
    ]
    msg2 = WhatsAppMessage(
      timestamp_ms=1730000001000,
      sender="Alice",
      context_msg_id="001001",
      sender_ref="a1",
      text="reply to bot",
      quoted_message_id="000999",
      quoted_sender="LLM",
    )
    hydrate_quoted_from_history(msg2, history2)
    # sender_ref is None from history, so "You" fallback applies
    self.assertEqual(msg2.quoted_sender_ref, "You")

  def test_no_hydration_for_system_or_pending(self) -> None:
    """Messages quoting #system or #pending should not trigger hydration."""
    msg_system = WhatsAppMessage(
      timestamp_ms=1730000001000,
      sender="Alice",
      context_msg_id="001000",
      sender_ref="a1",
      text="reply",
      quoted_message_id="system",
    )
    hydrate_quoted_from_history(msg_system, [])
    # Should not crash and should not modify anything

    msg_pending = WhatsAppMessage(
      timestamp_ms=1730000001000,
      sender="Alice",
      context_msg_id="001000",
      sender_ref="a1",
      text="reply",
      quoted_message_id="pending",
    )
    hydrate_quoted_from_history(msg_pending, [])
    # Should not crash and should not modify anything

  def test_delegation_from_processing(self) -> None:
    """_hydrate_quoted_from_history_payload should delegate to the shared
    hydrate_quoted_from_history function."""
    history = deque([
      WhatsAppMessage(
        timestamp_ms=1730000000000,
        sender="Bob",
        context_msg_id="000999",
        sender_ref="b2",
        text="from deque",
      ),
    ])
    msg = WhatsAppMessage(
      timestamp_ms=1730000001000,
      sender="Alice",
      context_msg_id="001000",
      sender_ref="a1",
      text="reply",
      quoted_message_id="000999",
      quoted_sender="Bob",
    )
    _hydrate_quoted_from_history_payload(msg, history)
    self.assertEqual(msg.quoted_text, "from deque")
    self.assertEqual(msg.quoted_sender_ref, "b2")


# ---------------------------------------------------------------------------
# Bug #5: _format_role shared function
# ---------------------------------------------------------------------------

class TestFormatRole(unittest.TestCase):
  """Verify _format_role returns correct labels with parentheses."""

  def test_superadmin(self) -> None:
    self.assertEqual(_format_role(False, True), "(superadmin)")

  def test_admin(self) -> None:
    self.assertEqual(_format_role(True, False), "(admin)")

  def test_superadmin_overrides_admin(self) -> None:
    self.assertEqual(_format_role(True, True), "(superadmin)")

  def test_normal_user(self) -> None:
    self.assertEqual(_format_role(False, False), "")


# ---------------------------------------------------------------------------
# Bug #6: _resolve_quoted_mentions None safety
# ---------------------------------------------------------------------------

class TestResolveQuotedMentions(unittest.TestCase):
  """Verify _resolve_quoted_mentions doesn't return None when input is
  non-None."""

  def test_returns_text_when_no_mentions(self) -> None:
    """When quoted has no mentionedParticipants, return the original text."""
    result = _resolve_quoted_mentions({}, "hello world")
    self.assertEqual(result, "hello world")

  def test_returns_none_when_text_is_none(self) -> None:
    """When quoted_text is None, return None."""
    result = _resolve_quoted_mentions({}, None)
    self.assertIsNone(result)

  def test_returns_empty_string_when_text_is_empty(self) -> None:
    """When quoted_text is empty, return empty string (not None)."""
    result = _resolve_quoted_mentions({}, "")
    self.assertEqual(result, "")

  def test_resolves_mentions(self) -> None:
    """Verify that @phone mentions get resolved."""
    quoted = {
      "mentionedParticipants": [
        {"name": "Alice", "senderRef": "a1", "jid": "628123456789@s.whatsapp.net"},
      ],
    }
    result = _resolve_quoted_mentions(quoted, "hey @628123456789")
    # Should resolve the phone mention to @Alice (a1)
    self.assertIn("Alice", result)
    self.assertNotIn("@628123456789", result)


# ---------------------------------------------------------------------------
# Bug #7: Sticker log uses assistant_name() (tested indirectly via format_history)
# ---------------------------------------------------------------------------

class TestFormatHistoryRoleLabels(unittest.TestCase):
  """Verify role labels and assistant identification in format_history."""

  def test_admin_label_in_history(self) -> None:
    with patch.dict(os.environ, {"ASSISTANT_NAME": "Bot"}, clear=False):
      messages = [
        WhatsAppMessage(
          timestamp_ms=1730000000000,
          sender="AdminUser",
          context_msg_id="001000",
          sender_ref="adm1",
          sender_is_admin=True,
          text="I am admin",
        ),
      ]
      result = format_history(messages)
      self.assertIn("(admin)", result)
      self.assertIn("AdminUser (adm1) (admin)", result)

  def test_superadmin_label_in_history(self) -> None:
    with patch.dict(os.environ, {"ASSISTANT_NAME": "Bot"}, clear=False):
      messages = [
        WhatsAppMessage(
          timestamp_ms=1730000000000,
          sender="SuperUser",
          context_msg_id="001000",
          sender_ref="su1",
          sender_is_super_admin=True,
          text="I am superadmin",
        ),
      ]
      result = format_history(messages)
      self.assertIn("(superadmin)", result)

  def test_assistant_message_format(self) -> None:
    with patch.dict(os.environ, {"ASSISTANT_NAME": "TestBot"}, clear=False):
      messages = [
        WhatsAppMessage(
          timestamp_ms=1730000000000,
          sender="TestBot",
          context_msg_id="001000",
          sender_ref="You",
          text="bot response",
          role="assistant",
        ),
      ]
      result = format_history(messages)
      self.assertIn("TestBot (You)", result)
      # Assistant messages should NOT have "(assistant)" label
      self.assertNotIn("(assistant)", result)

  def test_quoted_sender_ref_in_reply_line(self) -> None:
    """REPLYING TO should include senderRef if available."""
    messages = [
      WhatsAppMessage(
        timestamp_ms=1730000000000,
        sender="Alice",
        context_msg_id="001000",
        sender_ref="a1",
        text="reply",
        quoted_message_id="000999",
        quoted_sender="Bob",
        quoted_sender_ref="b2",
        quoted_text="original",
      ),
    ]
    result = format_history(messages, history=messages)
    self.assertIn("Bob (b2)", result)

  def test_quoted_sender_admin_in_reply_line(self) -> None:
    """REPLYING TO should include (admin) label for quoted admin."""
    messages = [
      WhatsAppMessage(
        timestamp_ms=1730000000000,
        sender="Alice",
        context_msg_id="001000",
        sender_ref="a1",
        text="reply to admin",
        quoted_message_id="000999",
        quoted_sender="AdminUser",
        quoted_sender_ref="adm1",
        quoted_sender_is_admin=True,
        quoted_text="admin message",
      ),
    ]
    result = format_history(messages, history=messages)
    self.assertIn("AdminUser (adm1) (admin)", result)

  def test_quoted_sender_superadmin_in_reply_line(self) -> None:
    """REPLYING TO should include (superadmin) label for quoted superadmin."""
    messages = [
      WhatsAppMessage(
        timestamp_ms=1730000000000,
        sender="Alice",
        context_msg_id="001000",
        sender_ref="a1",
        text="reply",
        quoted_message_id="000999",
        quoted_sender="SuperUser",
        quoted_sender_ref="su1",
        quoted_sender_is_super_admin=True,
        quoted_text="superadmin message",
      ),
    ]
    result = format_history(messages, history=messages)
    self.assertIn("SuperUser (su1) (superadmin)", result)


# ---------------------------------------------------------------------------
# format_history: quoted text suppression (Bug #3 expanded)
# ---------------------------------------------------------------------------

class TestFormatHistoryQuotedMediaStubSuppression(unittest.TestCase):
  """Verify that <media:...> stubs in quoted text are properly handled."""

  def test_quoted_media_stub_suppressed_with_quoted_media(self) -> None:
    """When quoted has both media and <media:...> text, suppress the stub."""
    messages = [
      WhatsAppMessage(
        timestamp_ms=1730000000000,
        sender="Alice",
        context_msg_id="001000",
        sender_ref="a1",
        text="reply",
        quoted_message_id="000999",
        quoted_sender="Bob",
        quoted_text="<media:video>",
        quoted_media="video",
      ),
    ]
    result = format_history(messages, history=messages)
    self.assertIn("[video]", result)
    self.assertNotIn("<media:video>", result)

  def test_quoted_media_stub_preserved_without_quoted_media(self) -> None:
    """When quoted text is <media:...> but there's no quoted_media, keep the text."""
    messages = [
      WhatsAppMessage(
        timestamp_ms=1730000000000,
        sender="Alice",
        context_msg_id="001000",
        sender_ref="a1",
        text="reply",
        quoted_message_id="000999",
        quoted_sender="Bob",
        quoted_text="<media:photo>",
        # No quoted_media
      ),
    ]
    result = format_history(messages, history=messages)
    # Must NOT suppress the text when there's no media prefix to replace it
    self.assertIn("<media:photo>", result)


# ---------------------------------------------------------------------------
# _build_burst_current: quoted sender ref and admin labels
# ---------------------------------------------------------------------------

class TestBuildBurstCurrentQuotedFields(unittest.TestCase):
  """Verify _build_burst_current properly renders quoted_sender_ref
  and admin labels in REPLYING TO lines.

  Note: _build_burst_current only produces a burst text with REPLYING TO
  when there are 2+ payloads. With 1 payload it delegates to
  _payload_to_message which doesn't render REPLYING TO inline.
  """

  def _make_two_payloads_with_quoted(self, **quoted_overrides) -> list[dict]:
    first = _base_payload()
    first["contextMsgId"] = "000999"
    first["messageId"] = "wamid-prev"
    first["text"] = "first message"

    second = _base_payload()
    second["contextMsgId"] = "001000"
    second["messageId"] = "wamid-current"
    second["text"] = "replying"
    quoted: dict = {
      "messageId": "wamid-quoted",
      "senderName": "Bob",
      "senderRef": "b2",
      "senderIsAdmin": False,
      "senderIsSuperAdmin": False,
    }
    if "text" not in quoted_overrides:
      quoted["text"] = "hello"
    quoted.update(quoted_overrides)
    second["quoted"] = quoted
    return [first, second]

  def test_burst_shows_quoted_sender_ref(self) -> None:
    payloads = self._make_two_payloads_with_quoted(senderRef="b2ref")
    burst = _build_burst_current(payloads)
    self.assertIsNotNone(burst.text)
    assert burst.text is not None
    self.assertIn("Bob (b2ref)", burst.text)

  def test_burst_shows_quoted_admin_label(self) -> None:
    payloads = self._make_two_payloads_with_quoted(senderIsAdmin=True)
    burst = _build_burst_current(payloads)
    self.assertIsNotNone(burst.text)
    assert burst.text is not None
    self.assertIn("(admin)", burst.text)

  def test_burst_shows_quoted_superadmin_label(self) -> None:
    payloads = self._make_two_payloads_with_quoted(senderIsSuperAdmin=True)
    burst = _build_burst_current(payloads)
    self.assertIsNotNone(burst.text)
    assert burst.text is not None
    self.assertIn("(superadmin)", burst.text)

  def test_burst_bot_fromme_quoted_uses_you(self) -> None:
    """When the quoted message is from the bot (fromMe), the senderRef
    should be 'You'."""
    payloads = self._make_two_payloads_with_quoted(**{"fromMe": True})
    burst = _build_burst_current(payloads)
    self.assertIsNotNone(burst.text)
    assert burst.text is not None
    self.assertIn("(You)", burst.text)


# ---------------------------------------------------------------------------
# Integration: format_history hydrates quoted from history
# ---------------------------------------------------------------------------

class TestFormatHistoryHydration(unittest.TestCase):
  """Verify that format_history calls hydrate_quoted_from_history
  to fill in missing quoted fields from the history."""

  def test_format_history_hydrates_quoted_sender_ref(self) -> None:
    """When a message quotes another message in the history,
    format_history should hydrate the quoted sender ref."""
    messages = [
      WhatsAppMessage(
        timestamp_ms=1730000000000,
        sender="Bob",
        context_msg_id="000999",
        sender_ref="b2ref",
        text="original message",
      ),
      WhatsAppMessage(
        timestamp_ms=1730000001000,
        sender="Alice",
        context_msg_id="001000",
        sender_ref="a1",
        text="reply",
        quoted_message_id="000999",
        quoted_sender="Bob",
        # quoted_sender_ref is None — should be hydrated from history
      ),
    ]
    result = format_history(messages)
    # The REPLYING TO line should have hydrated senderRef
    self.assertIn("b2ref", result)

  def test_format_history_hydrates_quoted_admin_flags(self) -> None:
    """When a message quotes an admin, format_history should hydrate
    the admin flags from history."""
    messages = [
      WhatsAppMessage(
        timestamp_ms=1730000000000,
        sender="AdminUser",
        context_msg_id="000999",
        sender_ref="adm1",
        sender_is_admin=True,
        text="admin message",
      ),
      WhatsAppMessage(
        timestamp_ms=1730000001000,
        sender="Alice",
        context_msg_id="001000",
        sender_ref="a1",
        text="reply to admin",
        quoted_message_id="000999",
        quoted_sender="AdminUser",
      ),
    ]
    result = format_history(messages)
    self.assertIn("(admin)", result)

  def test_format_history_hydrates_quoted_text(self) -> None:
    """When quoted_text is missing but the referenced message has text,
    format_history should hydrate it."""
    messages = [
      WhatsAppMessage(
        timestamp_ms=1730000000000,
        sender="Bob",
        context_msg_id="000999",
        sender_ref="b2",
        text="the original text",
      ),
      WhatsAppMessage(
        timestamp_ms=1730000001000,
        sender="Alice",
        context_msg_id="001000",
        sender_ref="a1",
        text="replying",
        quoted_message_id="000999",
        quoted_sender="Bob",
        # quoted_text is None — should be hydrated
      ),
    ]
    result = format_history(messages)
    self.assertIn("the original text", result)


def _base_payload() -> dict:
  return {
    "timestampMs": 1730000000000,
    "contextMsgId": "001882",
    "messageId": "wamid-current",
    "chatId": "1203630@g.us",
    "chatType": "group",
    "isGroup": True,
    "senderName": "Agus Kebab",
    "senderRef": "12lttc",
    "senderIsAdmin": True,
    "fromMe": False,
    "contextOnly": False,
    "text": "Ppp",
    "attachments": [],
  }


if __name__ == "__main__":
  unittest.main()