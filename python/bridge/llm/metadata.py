from __future__ import annotations

import os
import re

try:
  from ..history import WhatsAppMessage, assistant_name
  from ..db import get_prompt as db_get_prompt
  from ..log import setup_logging
  from ..config import HISTORY_LIMIT
  from ..messaging.processing import (
    _clean_text,
    _infer_media,
    _infer_quoted_media,
    _quoted_from_payload,
  )
  from ..messaging.filtering import (
    _is_provisional_assistant_echo,
    _payload_is_human,
    _payload_has_explicit_join_event,
  )
except ImportError:
  import sys
  from pathlib import Path
  sys.path.append(str(Path(__file__).resolve().parent.parent.parent))
  from bridge.history import WhatsAppMessage, assistant_name  # type: ignore
  from bridge.db import get_prompt as db_get_prompt  # type: ignore
  from bridge.log import setup_logging  # type: ignore
  from bridge.config import HISTORY_LIMIT  # type: ignore
  from bridge.messaging.processing import (  # type: ignore
    _clean_text,
    _infer_media,
    _infer_quoted_media,
    _quoted_from_payload,
  )
  from bridge.messaging.filtering import (  # type: ignore
    _is_provisional_assistant_echo,
    _payload_is_human,
    _payload_has_explicit_join_event,
  )

logger = setup_logging()


def _messages_since_last_assistant(
  history_messages: list[WhatsAppMessage],
  window_payloads: list[dict] | None = None,
) -> int:
  count = 0
  if window_payloads:
    for payload in reversed(window_payloads):
      if bool(payload.get("fromMe")):
        return count
      count += 1
  for msg in reversed(history_messages):
    if msg.role == "assistant":
      return count
    count += 1
  return count


def _assistant_replies_in_recent(
  history_messages: list[WhatsAppMessage],
  recent_window: int = 20,
  window_payloads: list[dict] | None = None,
) -> int:
  if recent_window <= 0:
    return 0
  combined_roles: list[str] = [msg.role for msg in history_messages]
  if window_payloads:
    combined_roles.extend(
      "assistant" if bool(payload.get("fromMe")) else "user"
      for payload in window_payloads
    )
  recent_roles = combined_roles[-recent_window:]
  return sum(1 for role in recent_roles if role == "assistant")


def _llm1_history_limit_for_metadata() -> int:
  raw = os.getenv("LLM1_HISTORY_LIMIT")
  if raw is None or not raw.strip():
    raw = os.getenv("HISTORY_LIMIT")
  try:
    parsed = int(raw) if raw is not None else HISTORY_LIMIT
  except (TypeError, ValueError):
    parsed = HISTORY_LIMIT
  if parsed > 0:
    return parsed
  return HISTORY_LIMIT if HISTORY_LIMIT > 0 else 20


def _is_group_join_action(action) -> bool:
  token = _clean_text(action).lower()
  if not token:
    return False
  if token in {"join", "add", "invite", "approve"}:
    return True
  return "join" in token


def _bot_name_mentioned_in_text(text: str | None, bot_name: str) -> bool:
  """Check if the bot's name appears in message text (case-insensitive, word boundary)."""
  if not text or not bot_name:
    return False
  name_lower = bot_name.strip().lower()
  if len(name_lower) < 2:
    return False
  text_lower = text.lower()
  # Use word boundary check to avoid false positives (e.g. "allow" matching "al")
  pattern = r'(?<![a-z0-9])' + re.escape(name_lower) + r'(?![a-z0-9])'
  return bool(re.search(pattern, text_lower))


def _bot_name_mentioned_in_payloads(payloads: list[dict], bot_name: str) -> bool:
  """Check if any payload in the window mentions the bot by name in text."""
  for payload in payloads:
    text = payload.get("text")
    if isinstance(text, str) and _bot_name_mentioned_in_text(text, bot_name):
      return True
    # Also check quoted text
    quoted = payload.get("quoted")
    if isinstance(quoted, dict):
      quoted_text = quoted.get("text")
      if isinstance(quoted_text, str) and _bot_name_mentioned_in_text(quoted_text, bot_name):
        return True
  return False


def _build_llm1_context_metadata(
  history_before_current: list[WhatsAppMessage],
  trigger_window_payloads: list[dict],
) -> dict:
  effective_window_payloads = [
    payload
    for payload in trigger_window_payloads
    if not _is_provisional_assistant_echo(history_before_current, payload)
  ]
  human_payloads = [payload for payload in effective_window_payloads if _payload_is_human(payload)]
  bot_mentioned_in_window = any(bool(payload.get("botMentioned")) for payload in human_payloads)
  replied_to_bot_in_window = any(bool(payload.get("repliedToBot")) for payload in human_payloads)
  bot_mention_count_in_window = sum(
    1
    for payload in human_payloads
    if bool(payload.get("botMentioned"))
  )

  # Detect bot name mentioned in text (without explicit @mention)
  configured_bot_name = assistant_name()
  bot_name_in_text = _bot_name_mentioned_in_payloads(human_payloads, configured_bot_name)

  trigger_payload = (
    effective_window_payloads[-1]
    if effective_window_payloads
    else (trigger_window_payloads[-1] if trigger_window_payloads else {})
  )
  current_has_media = bool(_infer_media(trigger_payload))
  quoted_has_media = bool(_infer_quoted_media(_quoted_from_payload(trigger_payload)))

  explicit_join_payloads = [
    payload for payload in effective_window_payloads if _payload_has_explicit_join_event(payload)
  ]
  explicit_join_participants: set[str] = set()
  for payload in explicit_join_payloads:
    group_event = payload.get("groupEvent")
    if not isinstance(group_event, dict):
      continue
    participants = group_event.get("participants")
    if not isinstance(participants, list):
      continue
    for participant in participants:
      token = _clean_text(participant)
      if token:
        explicit_join_participants.add(token.lower())

  history_limit = _llm1_history_limit_for_metadata()
  standard_windows = [20, 50, 100, 200]
  assistant_reply_windows = [window for window in standard_windows if window <= history_limit]
  if history_limit not in standard_windows:
    assistant_reply_windows.append(history_limit)
  assistant_reply_windows = sorted(set(assistant_reply_windows))
  assistant_replies_by_window = {
    str(window): _assistant_replies_in_recent(
      history_before_current,
      recent_window=window,
      window_payloads=effective_window_payloads,
    )
    for window in assistant_reply_windows
  }
  return {
    "botMentionedInWindow": bot_mentioned_in_window,
    "repliedToBotInWindow": replied_to_bot_in_window,
    "botMentionCountInWindow": bot_mention_count_in_window,
    "botNameMentionedInText": bot_name_in_text,
    "currentHasMedia": current_has_media,
    "quotedHasMedia": quoted_has_media,
    "messagesSinceAssistantReply": _messages_since_last_assistant(
      history_before_current,
      effective_window_payloads,
    ),
    "assistantRepliesByWindow": assistant_replies_by_window,
    "humanMessagesInWindow": len(human_payloads),
    "explicitJoinEventsInWindow": len(explicit_join_payloads),
    "explicitJoinParticipantsInWindow": len(explicit_join_participants),
  }


def _resolve_group_prompt_context(payload: dict) -> tuple[str | None, str | None]:
  chat_id = payload.get("chatId")
  raw_description = payload.get("groupDescription")
  description = _clean_text(raw_description) or None

  db_prompt = db_get_prompt(chat_id) if chat_id else None
  return description, db_prompt
