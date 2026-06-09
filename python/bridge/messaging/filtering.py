from __future__ import annotations

try:
  from ..history import WhatsAppMessage, assistant_name_pattern
  from ..log import setup_logging
  from ..config import ASSISTANT_ECHO_MERGE_WINDOW_MS
  from .processing import (
    _clean_text,
    _reply_signature,
    _is_context_only_payload,
  )
except ImportError:
  import sys
  from pathlib import Path
  sys.path.append(str(Path(__file__).resolve().parent.parent.parent))
  from bridge.history import WhatsAppMessage, assistant_name_pattern  # type: ignore
  from bridge.log import setup_logging  # type: ignore
  from bridge.config import ASSISTANT_ECHO_MERGE_WINDOW_MS  # type: ignore
  from bridge.messaging.processing import (  # type: ignore
    _clean_text,
    _reply_signature,
    _is_context_only_payload,
  )

logger = setup_logging()


def _chat_state_from_payload(payload: dict) -> tuple[str, bool, bool]:
  raw_chat_type = str(payload.get("chatType") or "").strip().lower()
  if raw_chat_type not in {"private", "group"}:
    raw_chat_type = "group" if bool(payload.get("isGroup")) else "private"
  return raw_chat_type, bool(payload.get("botIsAdmin")), bool(payload.get("botIsSuperAdmin"))


def _payload_timestamp_ms(payload: dict) -> int | None:
  raw = payload.get("timestampMs")
  try:
    ts = int(raw)
  except (TypeError, ValueError):
    return None
  return ts if ts > 0 else None


def _payload_triggers_llm1(payload: dict) -> bool:
  message_type = str(payload.get("messageType") or "").strip().lower()
  if message_type == "reactionmessage":
    return False
  if not _is_context_only_payload(payload):
    return True
  return bool(payload.get("triggerLlm1"))


def _message_matches_prefix(payload: dict, triggers: set[str]) -> bool:
  """Check if a payload matches any enabled prefix trigger."""
  if not triggers:
    return False
  if "tag" in triggers and bool(payload.get("botMentioned")):
    return True
  if "reply" in triggers and bool(payload.get("repliedToBot")):
    return True
  if "join" in triggers:
    msg_type = str(payload.get("messageType") or "").strip().lower()
    if msg_type == "groupparticipantsupdate":
      return True
  if "name" in triggers:
    text = _clean_text(payload.get("text"))
    if text and assistant_name_pattern().search(text):
      return True
  return False


def _payload_has_meaningful_content(payload: dict) -> bool:
  if _is_context_only_payload(payload):
    return True

  text = _clean_text(payload.get("text"))
  if text:
    return True

  attachments = payload.get("attachments") or []
  if attachments:
    return True

  if payload.get("location"):
    return True

  quoted = payload.get("quoted")
  if isinstance(quoted, dict):
    if _clean_text(quoted.get("text")):
      return True
    if quoted.get("messageId") or quoted.get("type") or quoted.get("senderName") or quoted.get("senderId"):
      return True

  return False


def _payload_is_human(payload: dict) -> bool:
  # `contextOnly` non-fromMe events are synthetic context (e.g. group updates),
  # not real human-authored chat messages.
  return (not bool(payload.get("fromMe"))) and (not bool(payload.get("contextOnly")))


def _is_provisional_assistant_echo(
  history_messages: list[WhatsAppMessage],
  payload: dict,
) -> bool:
  if not bool(payload.get("fromMe")):
    return False
  if not bool(payload.get("contextOnly")):
    return False

  payload_sig = _reply_signature(payload.get("text"))
  if not payload_sig:
    return False

  payload_ts = _payload_timestamp_ms(payload)
  for msg in reversed(history_messages):
    if msg.role != "assistant":
      continue
    msg_id = msg.message_id or ""
    if not msg_id.startswith("local-send-"):
      continue
    candidate_sig = _reply_signature(msg.text)
    if not candidate_sig or candidate_sig != payload_sig:
      continue
    if payload_ts is not None and ASSISTANT_ECHO_MERGE_WINDOW_MS > 0:
      age_delta = payload_ts - msg.timestamp_ms
      if age_delta < 0 or age_delta > ASSISTANT_ECHO_MERGE_WINDOW_MS:
        continue
    return True
  return False


def _payload_has_explicit_join_event(payload: dict) -> bool:
  group_event = payload.get("groupEvent")
  if isinstance(group_event, dict):
    action = group_event.get("action")
    token = _clean_text(action).lower()
    if token and (token in {"join", "add", "invite", "approve"} or "join" in token):
      return True

  message_type = str(payload.get("messageType") or "").strip().lower()
  if message_type != "groupparticipantsupdate":
    return False

  text = _clean_text(payload.get("text")).lower()
  return ("joined the group" in text) or ("new members joined the group" in text)
