from __future__ import annotations

import re
from typing import Deque

from wasocket.correlation import make_request_id

from ..history import (
  WhatsAppMessage,
  assistant_name,
  assistant_sender_ref,
  format_context_time,
  hydrate_quoted_from_history,
  _format_role,
)
from ..log import setup_logging
from ..config import (
  HISTORY_LIMIT,
  ASSISTANT_ECHO_MERGE_WINDOW_MS,
)

logger = setup_logging()

CONTEXT_MSG_ID_RE = re.compile(r"^\s*(\d{6})\s*$")
SENDER_REF_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$")
EMPTY_TARGET_TOKENS = {"none", "null", "no", "nil", "-", ""}
SYSTEM_CONTEXT_TOKEN = "system"
MENTION_SUMMARY_MAX_ITEMS = 8

# Regex to extract the first fenced code block from LLM output.
# Matches ```lang\n...\n``` and ~~~lang\n...\n~~~ (some LLMs use tildes).
# Supports 3+ backticks so 4-fence (````) works for code containing ```.
# Uses backreference so opening/closing fence length matches exactly,
# preventing truncation when the code content itself contains backticks.
# Requires a newline before the closing fence so inline ``` isn't matched.
_CODE_BLOCK_RE = re.compile(
  r"(?P<fence>`{3,}|~{3,})"   # Opening fence: 3+ backticks or tildes
  r"[a-zA-Z0-9+._ -]*"         # Optional language identifier
  r"\n"                          # Newline after opening fence
  r"(?P<content>[\s\S]*?)"      # Content (non-greedy, DOTALL)
  r"\n(?P=fence)"               # Closing fence: same type & length
  , re.DOTALL
)


def extract_first_code_block(text: str) -> str | None:
  """Extract content of the first fenced code block from *text*.

  Supports ``` and ~~~ fences, including 4+ backtick fences used when the
  code content itself contains triple backticks.  Returns the stripped
  inner content (without the opening/closing fences and optional language
  tag), or ``None`` if no code block is found.
  """
  if not isinstance(text, str):
    return None
  match = _CODE_BLOCK_RE.search(text)
  return match.group("content").strip() if match else None


def _append_history(buf: Deque[WhatsAppMessage], msg: WhatsAppMessage) -> None:
  buf.append(msg)
  while len(buf) > HISTORY_LIMIT:
    buf.popleft()


def _normalize_preview_text(value: str | None, limit: int = 220) -> str:
  text = " ".join((value or "").split())
  if len(text) <= limit:
    return text
  if limit <= 3:
    return text[:limit]
  return f"{text[:limit - 3]}..."


def _quoted_from_payload(payload: dict) -> dict:
  quoted = payload.get("quoted")
  if isinstance(quoted, dict):
    return quoted
  return {}


def _infer_quoted_media(quoted: dict) -> str | None:
  q_type = str(quoted.get("type") or "").strip().lower()
  if not q_type:
    return None
  if "sticker" in q_type:
    return "sticker"
  if "image" in q_type:
    return "image"
  if "video" in q_type:
    return "video"
  if "audio" in q_type:
    return "audio"
  if "document" in q_type:
    return "document"
  if "interactive" in q_type:
    return "interactive"
  return None


def _quoted_sender(quoted: dict) -> str | None:
  sender = quoted.get("senderName") or quoted.get("senderId")
  if not sender:
    return None
  return str(sender)


def _quoted_sender_ref(quoted: dict) -> str | None:
  ref = quoted.get("senderRef")
  return str(ref).strip() if ref else None


def _normalize_context_msg_id(value) -> str | None:
  if value is None:
    return None
  token = str(value).strip()
  if not token:
    return None
  match = CONTEXT_MSG_ID_RE.match(token)
  if not match:
    return None
  return match.group(1)


def _quoted_preview(payload: dict) -> str | None:
  quoted = _quoted_from_payload(payload)
  if not quoted:
    return None

  parts: list[str] = []
  sender = _quoted_sender(quoted)
  quoted_id = quoted.get("messageId")
  quoted_context_id = _normalize_context_msg_id(quoted.get("contextMsgId"))
  quoted_text = _normalize_preview_text(quoted.get("text"))
  quoted_media = _infer_quoted_media(quoted)
  quoted_text_is_media_stub = bool(
    quoted_text and quoted_text.startswith("<media:") and quoted_text.endswith(">")
  )

  if sender:
    parts.append(f"from={sender}")
  if quoted_context_id:
    parts.append(f"contextId={quoted_context_id}")
  elif quoted_id:
    parts.append(f"id={quoted_id}")
  if quoted_media:
    parts.append(f"quoted_media={quoted_media}")
  if quoted_text and not (quoted_media and quoted_text_is_media_stub):
    parts.append(f"quoted_text={quoted_text}")

  if not parts:
    return "reply_to:(present)"
  return f"reply_to: {' | '.join(parts)}"


def _clean_text(value) -> str:
  if isinstance(value, str):
    return value.strip()
  return ""


def _mentioned_participant_rows(payload: dict) -> list[dict]:
  rows: list[dict] = []
  mentioned_participants = payload.get("mentionedParticipants")
  if isinstance(mentioned_participants, list):
    for item in mentioned_participants:
      if not isinstance(item, dict):
        continue
      name = _clean_text(item.get("name")) or None
      sender_ref = _clean_text(item.get("senderRef")) or None
      jid = _clean_text(item.get("jid")) or None
      if not (name or sender_ref or jid):
        continue
      rows.append(
        {
          "name": name,
          "senderRef": sender_ref,
          "jid": jid,
          "isBot": bool(item.get("isBot")),
        }
      )
  if rows:
    return rows

  mentioned = payload.get("mentionedJids")
  if isinstance(mentioned, list):
    for jid in mentioned:
      token = _clean_text(jid)
      if not token:
        continue
      rows.append(
        {
          "name": None,
          "senderRef": None,
          "jid": token,
          "isBot": False,
        }
      )
  return rows


def _mention_label(row: dict) -> str:
  if bool(row.get("isBot")):
    name = _clean_text(row.get("name"))
    return f"{name} (bot)" if name else "bot (bot)"
  name = _clean_text(row.get("name"))
  sender_ref = _clean_text(row.get("senderRef"))
  jid = _clean_text(row.get("jid"))
  if name and sender_ref:
    return f"{name} ({sender_ref})"
  if name:
    return name
  if sender_ref:
    return sender_ref
  return jid


def _mention_labels(payload: dict, *, max_items: int = MENTION_SUMMARY_MAX_ITEMS) -> list[str]:
  rows = _mentioned_participant_rows(payload)
  if not rows:
    return []

  labels: list[str] = []
  seen: set[str] = set()
  for row in rows:
    label = _mention_label(row)
    if not label:
      continue
    key = label.casefold()
    if key in seen:
      continue
    seen.add(key)
    labels.append(label)
  if max_items > 0:
    return labels[:max_items]
  return labels


def _mention_number_candidates(row: dict) -> list[str]:
  jid = _clean_text(row.get("jid"))
  if not jid:
    return []
  local = jid.split("@", 1)[0].strip()
  if not local:
    return []
  candidates = [f"@{local}"]
  digits = re.sub(r"\D+", "", local)
  if digits and digits != local:
    candidates.append(f"@{digits}")
  return candidates


def _replace_mentions_in_text(base_text: str, rows: list[dict], labels: list[str]) -> tuple[str, int]:
  if not base_text or not rows or not labels:
    return base_text, 0

  rendered = base_text
  replaced = 0
  for idx, row in enumerate(rows):
    if idx >= len(labels):
      break
    replacement = f"@{labels[idx]}"
    candidates = _mention_number_candidates(row)
    applied = False
    for candidate in candidates:
      if not candidate:
        continue
      if candidate in rendered:
        rendered = rendered.replace(candidate, replacement, 1)
        replaced += 1
        applied = True
        break
    if applied:
      continue
    # If the display-name form is already present in the text (e.g. WA sent
    # the mention as "@Vivy (bot)" instead of a raw JID), count it as replaced
    # so that the caller doesn't fall through to the prepend-all-tokens path
    # which would produce a duplicate like "@Vivy (bot) @Vivy (bot)".
    if replacement in rendered:
      replaced += 1
  return rendered, replaced


def _bot_jid_from_rows(rows: list[dict]) -> str | None:
  for row in rows:
    if bool(row.get("isBot")):
      jid = _clean_text(row.get("jid"))
      if jid:
        return jid
  return None


def _ensure_bot_token_in_text(text: str, *, bot_mentioned: bool, bot_jid: str | None = None, bot_name: str = "") -> str:
  if not bot_mentioned:
    return text
  token = f"@{bot_name} (bot)" if bot_name else "@bot (bot)"
  if token in text:
    return text
  if bot_jid:
    for candidate in _mention_number_candidates({"jid": bot_jid}):
      if candidate in text:
        return text.replace(candidate, token, 1)
  stripped = text.strip()
  if stripped:
    return f"{token} {text}"
  return token


def _payload_text_with_mentions(payload: dict) -> str | None:
  base_text_raw = payload.get("text")
  base_text = base_text_raw if isinstance(base_text_raw, str) else ""
  if str(payload.get("messageType") or "").strip().lower() == "groupparticipantsupdate":
    return base_text if base_text else None

  rows = _mentioned_participant_rows(payload)
  labels = _mention_labels(payload)
  bot_jid = _bot_jid_from_rows(rows) if rows else None
  bot_mentioned = bool(payload.get("botMentioned"))
  configured_bot_name = assistant_name()
  if not rows or not labels:
    normalized = _ensure_bot_token_in_text(base_text, bot_mentioned=bot_mentioned, bot_jid=bot_jid, bot_name=configured_bot_name)
    return normalized if normalized else None

  rendered, replaced = _replace_mentions_in_text(base_text, rows, labels)
  if replaced > 0:
    normalized = _ensure_bot_token_in_text(rendered, bot_mentioned=bot_mentioned, bot_jid=bot_jid, bot_name=configured_bot_name)
    return normalized

  mention_tokens = [f"@{label}" for label in labels]
  if base_text and base_text.strip():
    normalized = f"{' '.join(mention_tokens)} {base_text}"
    return _ensure_bot_token_in_text(normalized, bot_mentioned=bot_mentioned, bot_jid=bot_jid, bot_name=configured_bot_name)
  normalized = " ".join(mention_tokens)
  return _ensure_bot_token_in_text(normalized, bot_mentioned=bot_mentioned, bot_jid=bot_jid, bot_name=configured_bot_name)


def _is_system_payload(payload: dict) -> bool:
  if not isinstance(payload, dict):
    return False
  message_type = str(payload.get("messageType") or "").strip()
  sender_id = str(payload.get("senderId") or "").strip().lower()
  if message_type == "actionLog":
    return True
  if isinstance(payload.get("groupEvent"), dict):
    return True
  if sender_id == "group-system@wazzap.local":
    return True
  return False


def _resolve_quoted_mentions(quoted: dict, quoted_text: str | None) -> str | None:
  """Resolve @phone_number mentions in quoted text using mentionedParticipants from the quoted payload.

  This converts raw @phone references to @Name (senderRef) format so that
  REPLYING TO lines show readable mentions instead of phone numbers.
  """
  if not quoted_text:
    return quoted_text
  mentioned_participants = quoted.get("mentionedParticipants")
  if not isinstance(mentioned_participants, list) or not mentioned_participants:
    return quoted_text
  rows: list[dict] = []
  for item in mentioned_participants:
    if not isinstance(item, dict):
      continue
    name = _clean_text(item.get("name")) or None
    sender_ref = _clean_text(item.get("senderRef")) or None
    jid = _clean_text(item.get("jid")) or None
    is_bot = bool(item.get("isBot"))
    if not (name or sender_ref or jid):
      continue
    rows.append({
      "name": name,
      "senderRef": sender_ref,
      "jid": jid,
      "isBot": is_bot,
    })
  if not rows:
    return quoted_text
  labels = [_mention_label(row) for row in rows]
  resolved, _ = _replace_mentions_in_text(quoted_text, rows, labels)
  # Also ensure bot token if needed
  bot_mentioned = any(row.get("isBot") for row in rows)
  bot_name = assistant_name()
  bot_jid = None
  for row in rows:
    if row.get("isBot") and row.get("jid"):
      bot_jid = row["jid"]
      break
  resolved = _ensure_bot_token_in_text(resolved, bot_mentioned=bot_mentioned, bot_jid=bot_jid, bot_name=bot_name)
  return resolved if resolved is not None else quoted_text


def _hydrate_quoted_from_history_payload(
  msg: WhatsAppMessage,
  history: Deque[WhatsAppMessage],
) -> None:
  """Look up the quoted message in history and fill in missing quoted fields.

  Delegates to :func:`hydrate_quoted_from_history` from :mod:`bridge.history`
  to avoid duplicating the hydration logic.
  """
  hydrate_quoted_from_history(msg, history)


def _display_context_msg_id_from_payload(payload: dict) -> str:
  if _is_system_payload(payload):
    return SYSTEM_CONTEXT_TOKEN
  return _normalize_context_msg_id(payload.get("contextMsgId")) or "000000"


def _infer_media(payload: dict) -> str | None:
  atts = payload.get("attachments") or []
  if not atts:
    if payload.get("messageType") == "stickerMessage":
      return "sticker"
    return None
  return atts[0].get("kind") or atts[0].get("mime") or "media"


def _payload_to_message(payload: dict) -> WhatsAppMessage:
  quoted = _quoted_from_payload(payload)
  is_context_only = bool(payload.get("contextOnly"))
  normalized_context_msg_id = _normalize_context_msg_id(payload.get("contextMsgId"))
  context_msg_id = SYSTEM_CONTEXT_TOKEN if _is_system_payload(payload) else normalized_context_msg_id
  role = "assistant" if bool(payload.get("fromMe")) else "user"
  if role == "assistant":
    sender = assistant_name()
    sender_ref = assistant_sender_ref()
    sender_is_admin = False
    sender_is_super_admin = False
  else:
    sender = payload.get("senderName") or payload.get("senderId") or payload.get("chatId")
    sender_ref = _clean_text(payload.get("senderRef")) or None
    sender_is_admin = bool(payload.get("senderIsAdmin"))
    sender_is_super_admin = bool(payload.get("senderIsSuperAdmin"))
  _q_sender = _quoted_sender(quoted)
  _q_sender_ref = _quoted_sender_ref(quoted)
  if bool(quoted.get("fromMe")):
    _q_sender = assistant_name()
    _q_sender_ref = assistant_sender_ref()
  return WhatsAppMessage(
    timestamp_ms=int(payload["timestampMs"]),
    sender=sender,
    context_msg_id=context_msg_id,
    sender_ref=sender_ref,
    sender_is_admin=sender_is_admin,
    sender_is_super_admin=sender_is_super_admin,
    text=_payload_text_with_mentions(payload),
    media=_infer_media(payload),
    quoted_message_id=(
      _normalize_context_msg_id(quoted.get("contextMsgId"))
      or (str(quoted.get("messageId")) if quoted.get("messageId") else None)
    ),
    quoted_sender=_q_sender,
    quoted_text=_resolve_quoted_mentions(quoted, quoted.get("text")),
    quoted_media=_infer_quoted_media(quoted),
    quoted_sender_ref=_q_sender_ref,
    quoted_sender_is_admin=bool(quoted.get("senderIsAdmin")),
    quoted_sender_is_super_admin=bool(quoted.get("senderIsSuperAdmin")),
    message_id=None if is_context_only else (str(payload.get("messageId")) if payload.get("messageId") else None),
    role=role,
  )


def _build_burst_current(payloads: list[dict]) -> WhatsAppMessage:
  last = payloads[-1]
  if len(payloads) == 1:
    return _payload_to_message(last)

  lines: list[str] = []
  for item in payloads:
    context_msg_id = _display_context_msg_id_from_payload(item)
    if bool(item.get("fromMe")):
      sender = assistant_name()
      sender_ref = assistant_sender_ref()
      role_label = ""  # (You) already identifies bot messages
    else:
      sender = item.get("senderName") or item.get("senderId") or item.get("chatId") or "unknown"
      sender_ref = _clean_text(item.get("senderRef")) or "unknown"
      role_label = _format_role(bool(item.get("senderIsAdmin")), bool(item.get("senderIsSuperAdmin")))
    
    timestamp_ms = int(item.get("timestampMs") or last.get("timestampMs") or 0)
    formatted_time = format_context_time(timestamp_ms)
    text = _normalize_preview_text(_payload_text_with_mentions(item))
    media = _infer_media(item)
    
    # Header line
    lines.append(f"[#{context_msg_id}] {formatted_time}")
    
    # Reply line
    quoted = _quoted_from_payload(item)
    if quoted:
      q_id = _normalize_context_msg_id(quoted.get("contextMsgId")) or quoted.get("messageId") or "000000"
      q_sender = _quoted_sender(quoted) or "someone"
      q_sender_ref = _quoted_sender_ref(quoted)
      q_text = _normalize_preview_text(_resolve_quoted_mentions(quoted, quoted.get("text")))
      q_media = _infer_quoted_media(quoted)

      # Build sender display: "Name (ref) (role)"
      q_is_admin = bool(quoted.get("senderIsAdmin"))
      q_is_super_admin = bool(quoted.get("senderIsSuperAdmin"))

      # If the quoted message is from the bot (fromMe), override sender display
      if bool(quoted.get("fromMe")):
        q_sender = assistant_name()
        q_sender_ref = assistant_sender_ref()
      elif bool(item.get("fromMe")):
        # The current sender is the bot replying — quoted sender stays as-is
        pass

      q_role_label = ""
      if q_is_super_admin:
        q_role_label = " (superadmin)"
      elif q_is_admin:
        q_role_label = " (admin)"

      if q_sender_ref:
        q_sender_display = f"{q_sender} ({q_sender_ref}){q_role_label}"
      else:
        q_sender_display = f"{q_sender}{q_role_label}"

      # Suppress generic <media:...> stub in quoted text when quoted_media already
      # carries the type — consistent with _message_text() in history.py.
      # Named sticker stubs (<media:sticker=name>) are kept so the sticker name is visible.
      if q_media and q_text and q_text.startswith("<media:") and q_text.endswith(">"):
        is_named_sticker = q_text.startswith("<media:sticker=") and len(q_text) > len("<media:sticker=>")
        if not is_named_sticker:
          q_text = ""

      q_content = f"[{q_media}] " if q_media else ""
      if q_text:
        q_content += f'"{q_text}"'
      elif not q_media:
        q_content = "(empty)"

      lines.append(f"REPLYING TO [#{q_id}] {q_sender_display}: {q_content}")

    # Content line
    media_part = f"[{media}] " if media else ""
    content_text = text or (media_part.strip() if media_part else "(empty)")
    if media and text:
      content_text = f"[{media}] {text}"
    
    role_suffix = f" {role_label}" if role_label else ""
    lines.append(f"{sender} ({sender_ref}){role_suffix}: {content_text}")
    lines.append("") # Spacer

  burst_text = (
    f"Burst messages ({len(payloads)} total, latest last):\n" + "\n".join(lines).strip()
  )
  return WhatsAppMessage(
    timestamp_ms=int(last["timestampMs"]),
    sender=last.get("senderName") or last.get("senderId") or last.get("chatId"),
    context_msg_id=_normalize_context_msg_id(last.get("contextMsgId")),
    sender_ref=_clean_text(last.get("senderRef")) or None,
    sender_is_admin=bool(last.get("senderIsAdmin")),
    sender_is_super_admin=bool(last.get("senderIsSuperAdmin")),
    text=burst_text,
    media=_infer_media(last),
    message_id=str(last.get("messageId")) if last.get("messageId") else None,
    role="user",
  )


def _collect_context_ids(messages: list[WhatsAppMessage] | Deque[WhatsAppMessage]) -> set[str]:
  ids: set[str] = set()
  for msg in messages:
    if not msg.context_msg_id:
      continue
    ids.add(msg.context_msg_id)
  return ids


def _reply_signature(text: str | None) -> str:
  if not isinstance(text, str):
    return ""
  return " ".join(text.split()).strip().lower()


def _merge_fromme_echo_into_provisional(
  history: Deque[WhatsAppMessage],
  echo_msg: WhatsAppMessage,
) -> bool:
  if ASSISTANT_ECHO_MERGE_WINDOW_MS <= 0:
    return False
  if echo_msg.role != "assistant":
    return False

  echo_sig = _reply_signature(echo_msg.text)
  if not echo_sig:
    return False

  for idx in range(len(history) - 1, -1, -1):
    candidate = history[idx]
    if candidate.role != "assistant":
      continue

    candidate_id = candidate.message_id or ""
    if not candidate_id.startswith("local-send-"):
      continue

    age_delta = echo_msg.timestamp_ms - candidate.timestamp_ms
    if age_delta > ASSISTANT_ECHO_MERGE_WINDOW_MS:
      break

    candidate_sig = _reply_signature(candidate.text)
    if not candidate_sig or candidate_sig != echo_sig:
      continue

    candidate.timestamp_ms = echo_msg.timestamp_ms
    candidate.sender = echo_msg.sender
    candidate.context_msg_id = echo_msg.context_msg_id
    candidate.sender_ref = echo_msg.sender_ref
    candidate.sender_is_admin = echo_msg.sender_is_admin
    candidate.text = echo_msg.text
    candidate.media = echo_msg.media
    candidate.quoted_message_id = echo_msg.quoted_message_id
    candidate.quoted_sender = echo_msg.quoted_sender
    candidate.quoted_text = echo_msg.quoted_text
    candidate.quoted_media = echo_msg.quoted_media
    candidate.quoted_sender_ref = echo_msg.quoted_sender_ref
    candidate.quoted_sender_is_admin = echo_msg.quoted_sender_is_admin
    candidate.quoted_sender_is_super_admin = echo_msg.quoted_sender_is_super_admin
    candidate.message_id = echo_msg.message_id
    candidate.role = echo_msg.role
    return True

  return False


def _append_or_merge_history_payload(
  history: Deque[WhatsAppMessage],
  payload: dict,
) -> None:
  msg = _payload_to_message(payload)
  _hydrate_quoted_from_history_payload(msg, history)
  if bool(payload.get("fromMe")) and _merge_fromme_echo_into_provisional(history, msg):
    return
  _append_history(history, msg)


def _extract_send_ack_context_msg_id(payload: dict) -> str | None:
  if not isinstance(payload, dict):
    return None
  result = payload.get("result")
  if not isinstance(result, dict):
    return None
  sent = result.get("sent")
  if not isinstance(sent, list):
    return None

  picked: dict | None = None
  for row in sent:
    if not isinstance(row, dict):
      continue
    if str(row.get("kind") or "").strip().lower() == "text":
      picked = row
      break
    if picked is None:
      picked = row

  if not picked:
    return None
  return _normalize_context_msg_id(picked.get("contextMsgId"))


def _extract_all_send_ack_entries(payload: dict) -> list[dict]:
  """Return all entries from the ``result.sent`` array of a ``send_ack`` / ``action_ack``.

  Each entry is a dict with at least ``kind`` and ``contextMsgId`` keys.
  Returns an empty list if the payload structure is unexpected.
  """
  if not isinstance(payload, dict):
    return []
  result = payload.get("result")
  if not isinstance(result, dict):
    return []
  sent = result.get("sent")
  if not isinstance(sent, list):
    return []
  entries: list[dict] = []
  for row in sent:
    if isinstance(row, dict) and row.get("contextMsgId"):
      entries.append(row)
  return entries


def _hydrate_provisional_context_id_from_ack(
  history: Deque[WhatsAppMessage],
  *,
  request_id: str,
  context_msg_id: str | None,
) -> bool:
  if not request_id or not context_msg_id:
    return False
  local_message_id = f"local-send-{request_id}"
  for idx in range(len(history) - 1, -1, -1):
    candidate = history[idx]
    if candidate.role != "assistant":
      continue
    if (candidate.message_id or "") != local_message_id:
      continue
    candidate.context_msg_id = context_msg_id
    return True
  return False


def _make_request_id(action: str) -> str:
  """Allocate a request id from the single shared SDK allocator (Step 12).

  The bridge no longer keeps its own private request-id counter (which had a
  format identical to the SDK's and so risked colliding). It now delegates to
  :func:`wasocket.correlation.make_request_id` — the ONE process-wide
  allocator (CONTRACT §3) — keeping the id FORMAT identical
  (``"<tag>-<unix_ms>-<seq6>"``).
  """
  return make_request_id(action)


def _is_context_only_payload(payload: dict) -> bool:
  return bool(payload.get("contextOnly"))
