from __future__ import annotations

import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch


PYTHON_DIR = Path(__file__).resolve().parents[1]
if str(PYTHON_DIR) not in sys.path:
  sys.path.insert(0, str(PYTHON_DIR))

from bridge.history import WhatsAppMessage, format_context_time, format_history
from bridge.llm.prompt import _metadata_block, build_llm1_prompt
from bridge.llm.llm2 import _context_injection_block
from bridge.messaging.processing import _build_burst_current, _quoted_preview
from bridge.llm.metadata import _build_llm1_context_metadata


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


def _quoted_payload(q_type: str | None, text: str | None = None) -> dict:
  quoted: dict = {
    "messageId": "A56453C5E6E9C87D762D8ADAAB751906",
    "senderName": "Agus Kebab",
  }
  if q_type is not None:
    quoted["type"] = q_type
  if text is not None:
    quoted["text"] = text
  return quoted


class ReplyToSerializationTests(unittest.TestCase):
  def test_quoted_preview_uses_quoted_media_not_media_for_media_quote(self) -> None:
    payload = _base_payload()
    payload["quoted"] = _quoted_payload("imageMessage", "<media:image>")

    preview = _quoted_preview(payload)

    self.assertIsNotNone(preview)
    assert preview is not None
    self.assertIn("reply_to:", preview)
    self.assertIn("quoted_media=image", preview)
    self.assertNotIn("| media=image", preview)
    self.assertNotIn("quoted_text=<media:image>", preview)

  def test_quoted_preview_keeps_non_stub_quoted_text(self) -> None:
    payload = _base_payload()
    payload["quoted"] = _quoted_payload("imageMessage", "ini caption asli")

    preview = _quoted_preview(payload)

    self.assertIsNotNone(preview)
    assert preview is not None
    self.assertIn("quoted_media=image", preview)
    self.assertIn("quoted_text=ini caption asli", preview)

  def test_quoted_preview_reports_present_for_untyped_metadata_only(self) -> None:
    payload = _base_payload()
    payload["quoted"] = {"foo": "bar"}

    self.assertEqual(_quoted_preview(payload), "reply_to:(present)")


class HistoryFormattingTests(unittest.TestCase):
  def test_format_history_uses_env_utc_offset_when_set(self) -> None:
    timestamp_ms = 1730000000000
    messages = [
      WhatsAppMessage(
        timestamp_ms=timestamp_ms,
        sender="Agus Kebab",
        context_msg_id="001880",
        sender_ref="12lttc",
        text="pakai offset env",
      )
    ]

    with patch.dict(os.environ, {"CONTEXT_TIME_UTC_OFFSET_HOURS": "4"}, clear=False):
      rendered = format_history(messages)

    expected_time = datetime.fromtimestamp(
      timestamp_ms / 1000,
      tz=timezone(timedelta(hours=4)),
    ).strftime("%H:%M")
    self.assertIn(expected_time, rendered)

  def test_format_context_time_falls_back_to_local_timezone_when_env_empty(self) -> None:
    timestamp_ms = 1730000000000

    with patch.dict(os.environ, {"CONTEXT_TIME_UTC_OFFSET_HOURS": ""}, clear=False):
      formatted = format_context_time(timestamp_ms)

    expected_time = datetime.fromtimestamp(timestamp_ms / 1000).strftime("%H:%M")
    self.assertEqual(formatted, expected_time)

  def test_format_history_single_comprehensive_mixed_messages(self) -> None:
    messages = [
      WhatsAppMessage(
        timestamp_ms=1730000000000,
        sender="Agus Kebab",
        context_msg_id="001880",
        sender_ref="12lttc",
        sender_is_admin=True,
        text="pesan teks biasa",
      ),
      WhatsAppMessage(
        timestamp_ms=1730000001000,
        sender="Agus Kebab",
        context_msg_id="001881",
        sender_ref="12lttc",
        text="caption media",
        media="image",
      ),
      WhatsAppMessage(
        timestamp_ms=1730000002000,
        sender="Agus Kebab",
        context_msg_id="001882",
        sender_ref="12lttc",
        text="reply ke image",
        quoted_message_id="A56453C5E6E9C87D762D8ADAAB751906",
        quoted_sender="Agus Kebab",
        quoted_text="<media:image>",
        quoted_media="image",
      ),
      WhatsAppMessage(
        timestamp_ms=1730000003000,
        sender="User X",
        context_msg_id="001883",
        sender_ref="u1",
        text="reply dengan text quote asli",
        quoted_message_id="A56453C5E6E9C87D762D8ADAAB751999",
        quoted_sender="User Y",
        quoted_text="hello world",
        quoted_media="image",
      ),
      WhatsAppMessage(
        timestamp_ms=1730000004000,
        sender="LLM",
        context_msg_id="not-a-6-digit-id",
        sender_ref="bot",
        text="assistant provisional",
        role="assistant",
      ),
      WhatsAppMessage(
        timestamp_ms=1730000005000,
        sender="",
        context_msg_id="system",
        sender_ref="",
        text="system event line",
      ),
    ]

    with patch.dict(os.environ, {"ASSISTANT_NAME": "Vivy Custom"}, clear=False):
      rendered = format_history(messages)

    self.assertIn("[#001880]", rendered)
    self.assertIn("Agus Kebab (12lttc) (admin): pesan teks biasa", rendered)
    self.assertIn("[#001881]", rendered)
    self.assertIn("Agus Kebab (12lttc): [image] caption media", rendered)
    self.assertIn("reply ke image", rendered)
    self.assertNotIn("| media=image", rendered)
    self.assertNotIn('quoted_text=<media:image>', rendered)
    self.assertIn("hello world", rendered)
    self.assertIn("[#pending]", rendered)
    self.assertIn("Vivy Custom (You): assistant provisional", rendered)
    self.assertIn("[#system]", rendered)
    self.assertIn("unknown (unknown): system event line", rendered)

  def test_build_burst_current_uses_env_utc_offset_when_set(self) -> None:
    payload = _base_payload()
    payload["text"] = "pesan pertama"
    payload["messageId"] = "wamid-burst-1"
    payload2 = dict(payload)
    payload2["contextMsgId"] = "001883"
    payload2["messageId"] = "wamid-burst-2"
    payload2["timestampMs"] = payload["timestampMs"] + 1000
    payload2["text"] = "cek burst timezone"

    with patch.dict(os.environ, {"CONTEXT_TIME_UTC_OFFSET_HOURS": "4"}, clear=False):
      burst = _build_burst_current([payload, payload2])

    expected_time = datetime.fromtimestamp(
      payload["timestampMs"] / 1000,
      tz=timezone(timedelta(hours=4)),
    ).strftime("%H:%M")
    self.assertIn(expected_time, burst.text or "")


class MetadataFlagTests(unittest.TestCase):
  def test_current_and_quoted_media_flags_matrix(self) -> None:
    cases = [
      {
        "name": "plain_text_no_quote",
        "attachments": [],
        "quoted": None,
        "expect_current": False,
        "expect_quoted": False,
      },
      {
        "name": "image_attachment_no_quote",
        "attachments": [{"kind": "image"}],
        "quoted": None,
        "expect_current": True,
        "expect_quoted": False,
      },
      {
        "name": "reply_text_to_image",
        "attachments": [],
        "quoted": _quoted_payload("imageMessage", "<media:image>"),
        "expect_current": False,
        "expect_quoted": True,
      },
      {
        "name": "attachment_and_quoted_media",
        "attachments": [{"kind": "video"}],
        "quoted": _quoted_payload("imageMessage", "<media:image>"),
        "expect_current": True,
        "expect_quoted": True,
      },
      {
        "name": "conversation_quote",
        "attachments": [],
        "quoted": _quoted_payload("conversation", "teks"),
        "expect_current": False,
        "expect_quoted": False,
      },
      {
        "name": "view_once_image_quote",
        "attachments": [],
        "quoted": _quoted_payload("viewOnceImageMessage", "<media:image>"),
        "expect_current": False,
        "expect_quoted": True,
      },
      {
        "name": "view_once_generic_quote",
        "attachments": [],
        "quoted": _quoted_payload("viewOnceMessage", "<media:image>"),
        "expect_current": False,
        "expect_quoted": False,
      },
      {
        "name": "sticker_quote",
        "attachments": [],
        "quoted": _quoted_payload("stickerMessage", "<media:sticker>"),
        "expect_current": False,
        "expect_quoted": True,
      },
      {
        "name": "audio_quote",
        "attachments": [],
        "quoted": _quoted_payload("audioMessage", "<media:audio>"),
        "expect_current": False,
        "expect_quoted": True,
      },
      {
        "name": "document_quote",
        "attachments": [],
        "quoted": _quoted_payload("documentMessage", "<media:document>"),
        "expect_current": False,
        "expect_quoted": True,
      },
    ]

    for case in cases:
      with self.subTest(case=case["name"]):
        payload = _base_payload()
        payload["attachments"] = case["attachments"]
        payload["quoted"] = case["quoted"]

        metadata = _build_llm1_context_metadata([], [payload])

        self.assertEqual(metadata["currentHasMedia"], case["expect_current"])
        self.assertEqual(metadata["quotedHasMedia"], case["expect_quoted"])

  def test_metadata_falls_back_to_trigger_payload_when_effective_window_empty(self) -> None:
    history = [
      WhatsAppMessage(
        timestamp_ms=1730000000000,
        sender="LLM",
        context_msg_id="pending",
        sender_ref="bot",
        text="samakan text echo",
        message_id="local-send-0001",
        role="assistant",
      )
    ]
    trigger_payload = _base_payload()
    trigger_payload["fromMe"] = True
    trigger_payload["contextOnly"] = True
    trigger_payload["text"] = "samakan text echo"
    trigger_payload["quoted"] = _quoted_payload("imageMessage", "<media:image>")
    trigger_payload["attachments"] = []

    metadata = _build_llm1_context_metadata(history, [trigger_payload])

    self.assertFalse(metadata["currentHasMedia"])
    self.assertTrue(metadata["quotedHasMedia"])


class PromptContextTests(unittest.TestCase):
  def test_burst_context_line_uses_quoted_media_token(self) -> None:
    first = _base_payload()
    first["contextMsgId"] = "001881"
    first["messageId"] = "wamid-prev"
    first["senderName"] = "User X"
    first["senderRef"] = "u1"
    first["text"] = "halo"
    first["senderIsAdmin"] = False
    first["quoted"] = None

    second = _base_payload()
    second["quoted"] = _quoted_payload("imageMessage", "<media:image>")

    burst = _build_burst_current([first, second])

    self.assertIsNotNone(burst.text)
    assert burst.text is not None
    self.assertIn("REPLYING TO", burst.text)
    self.assertIn("[image]", burst.text)
    self.assertNotIn("| media=image", burst.text)
    self.assertNotIn("quoted_text=<media:image>", burst.text)

  def test_llm1_prompt_contains_media_disambiguation_and_no_false_token(self) -> None:
    payload = _base_payload()
    payload["quoted"] = _quoted_payload("imageMessage", "<media:image>")

    current = _build_burst_current([payload])
    metadata = _build_llm1_context_metadata([], [payload])
    llm_payload = dict(payload)
    llm_payload.update(metadata)

    prompt = build_llm1_prompt(
      history=[],
      current=current,
      history_limit=20,
      message_max_chars=500,
      metadata_block=_metadata_block(llm_payload),
      group_description=None,
      prompt_override=None,
    )

    metadata_text = prompt[2]["content"]
    context_text = prompt[3]["content"]

    self.assertNotIn("The latest trigger message has no attached media.", metadata_text)
    # quotedHasMedia is surfaced in llm2 context, not in llm1 metadata block
    self.assertIn("[image]", context_text)
    self.assertNotIn("| media=image", context_text)

  def test_llm2_context_injection_mentions_quoted_vs_current_media(self) -> None:
    payload = _base_payload()
    payload.update(
      {
        "chatType": "group",
        "botIsAdmin": True,
        "botIsSuperAdmin": False,
        "assistantRepliesByWindow": {"20": 0},
        "humanMessagesInWindow": 1,
        "explicitJoinEventsInWindow": 0,
        "explicitJoinParticipantsInWindow": 0,
        "currentHasMedia": False,
        "quotedHasMedia": True,
      }
    )

    text = _context_injection_block(
      payload,
      chat_type="group",
      bot_is_admin=True,
      bot_is_super_admin=False,
    )

    self.assertNotIn("The latest trigger message has no attached media.", text)
    self.assertIn("includes media", text)


class ContextPreviewPrintTests(unittest.TestCase):
  def _print_case(self, title: str, payload: dict) -> None:
    current = _build_burst_current([payload])
    metadata = _build_llm1_context_metadata([], [payload])
    llm_payload = dict(payload)
    llm_payload.update(metadata)

    llm1_meta = _metadata_block(llm_payload)
    llm2_meta = _context_injection_block(
      llm_payload,
      chat_type=str(payload.get("chatType") or "group"),
      bot_is_admin=bool(payload.get("botIsAdmin")),
      bot_is_super_admin=bool(payload.get("botIsSuperAdmin")),
    )
    prompt = build_llm1_prompt(
      history=[],
      current=current,
      history_limit=20,
      message_max_chars=500,
      metadata_block=llm1_meta,
      group_description=None,
      prompt_override=None,
    )
    prompt_context = prompt[3]["content"]

    print(f"\n===== {title} =====", flush=True)
    print("current messages(burst):", flush=True)
    print(current.text or "(empty)", flush=True)
    print("\nLLM1 metadata:", flush=True)
    print(llm1_meta, flush=True)
    print("\nLLM1 prompt context block:", flush=True)
    print(prompt_context, flush=True)
    print("\nLLM2 metadata/context injection:", flush=True)
    print(llm2_meta, flush=True)
    print("===== END =====\n", flush=True)

  def test_print_real_llm_context_samples(self) -> None:
    reply_text_to_image = _base_payload()
    reply_text_to_image.update(
      {
        "botIsAdmin": True,
        "botIsSuperAdmin": False,
        "assistantRepliesByWindow": {"20": 0},
        "humanMessagesInWindow": 1,
        "explicitJoinEventsInWindow": 0,
        "explicitJoinParticipantsInWindow": 0,
        "quoted": _quoted_payload("imageMessage", "<media:image>"),
      }
    )

    send_image = _base_payload()
    send_image.update(
      {
        "contextMsgId": "001883",
        "messageId": "wamid-image",
        "text": "nih foto",
        "attachments": [{"kind": "image", "mime": "image/jpeg"}],
        "botIsAdmin": True,
        "botIsSuperAdmin": False,
        "assistantRepliesByWindow": {"20": 0},
        "humanMessagesInWindow": 1,
        "explicitJoinEventsInWindow": 0,
        "explicitJoinParticipantsInWindow": 0,
      }
    )

    reply_text_to_view_once_image = _base_payload()
    reply_text_to_view_once_image.update(
      {
        "contextMsgId": "001884",
        "messageId": "wamid-viewonce-reply",
        "text": "ok noted",
        "botIsAdmin": True,
        "botIsSuperAdmin": False,
        "assistantRepliesByWindow": {"20": 0},
        "humanMessagesInWindow": 1,
        "explicitJoinEventsInWindow": 0,
        "explicitJoinParticipantsInWindow": 0,
        "quoted": _quoted_payload("viewOnceImageMessage", "<media:image>"),
      }
    )

    self._print_case("CASE: reply text -> quoted image", reply_text_to_image)
    self._print_case("CASE: send image attachment", send_image)
    self._print_case("CASE: reply text -> quoted view-once image", reply_text_to_view_once_image)

    # Keep assertions so this remains a real unit test, not print-only.
    md_reply_image = _build_llm1_context_metadata([], [reply_text_to_image])
    md_send_image = _build_llm1_context_metadata([], [send_image])
    md_reply_view_once = _build_llm1_context_metadata([], [reply_text_to_view_once_image])
    self.assertEqual((md_reply_image["currentHasMedia"], md_reply_image["quotedHasMedia"]), (False, True))
    self.assertEqual((md_send_image["currentHasMedia"], md_send_image["quotedHasMedia"]), (True, False))
    self.assertEqual((md_reply_view_once["currentHasMedia"], md_reply_view_once["quotedHasMedia"]), (False, True))


if __name__ == "__main__":
  unittest.main()
