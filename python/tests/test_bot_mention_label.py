"""Bug fix: the bot's mention label must come from the configured
ASSISTANT_NAME, not the WhatsApp push-name the gateway resolved for the bot's
JID.

Symptom (real history):

    whoami (jamidd) (admin): @Vivy (bot) (bot) buatin quiz

The gateway resolved the bot's profile/push-name as ``Vivy (bot)`` (already
suffixed) while ``ASSISTANT_NAME`` was ``Vivy``. ``_mention_label`` then
appended another ``(bot)`` — producing the doubled, inconsistent tag. The fix
makes the bot label always ``@<ASSISTANT_NAME> (bot)`` (matching ``(You)``
turns and the mention token declared in the system prompt).
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bridge.history import tenant_assistant_name_context
from bridge.messaging.processing import _mention_label, _payload_text_with_mentions


def test_bot_label_uses_assistant_name_not_pushname():
  # Gateway-resolved push-name already ends in "(bot)" — must be ignored.
  row = {"name": "Vivy (bot)", "senderRef": None, "jid": "111@s.whatsapp.net", "isBot": True}
  with tenant_assistant_name_context("Vivy"):
    assert _mention_label(row) == "Vivy (bot)"  # single (bot), from ASSISTANT_NAME


def test_bot_label_ignores_arbitrary_pushname():
  # Even a totally different push-name must not leak into the mention label.
  row = {"name": "Some Other Profile", "senderRef": None, "jid": "111@s.whatsapp.net", "isBot": True}
  with tenant_assistant_name_context("Vivy"):
    assert _mention_label(row) == "Vivy (bot)"


def test_bot_mention_in_text_is_not_doubled():
  # Raw WhatsApp text mentions the bot by its number ("@111"); the rendered
  # text must read "@Vivy (bot)" exactly once.
  payload = {
    "text": "@111 buatin quiz",
    "botMentioned": True,
    "mentionedParticipants": [
      {"name": "Vivy (bot)", "senderRef": None, "jid": "111@s.whatsapp.net", "isBot": True},
    ],
  }
  with tenant_assistant_name_context("Vivy"):
    rendered = _payload_text_with_mentions(payload)
  assert rendered == "@Vivy (bot) buatin quiz"
  assert "(bot) (bot)" not in rendered


def test_non_bot_mention_label_unchanged():
  # Non-bot participants still render as "@Name (senderRef)".
  row = {"name": "jeje", "senderRef": "29008b", "jid": "222@s.whatsapp.net", "isBot": False}
  assert _mention_label(row) == "jeje (29008b)"
