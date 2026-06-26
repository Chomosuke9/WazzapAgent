from __future__ import annotations

import contextlib
import contextvars
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Iterable, Optional, Sequence

from . import config

DEFAULT_ASSISTANT_NAME = "LLM"
ASSISTANT_CONTEXT_SENDER_REF = "You"

# Per-tenant assistant identity (CONTRACT.md §8 — multi-account). An
# :class:`~bridge.session.AgentSession` binds its own identity for the duration
# of its work via :func:`set_tenant_assistant_name`; while bound, all name
# resolution uses THAT tenant's identity instead of the process-global
# ``ASSISTANT_NAME`` env. When UNSET (default ``None`` — single-account / tests)
# the legacy env-based resolution below is used UNCHANGED, so single-account
# behaviour is byte-for-byte identical. This ContextVar is context-local (it
# does not leak across tenants), mirroring the ``_tenant_db_dir`` ContextVar in
# ``db/core.py`` — it is NOT shared mutable tenant state.
_tenant_assistant_name: contextvars.ContextVar[str | None] = contextvars.ContextVar(
  "bridge_tenant_assistant_name", default=None
)

# Legacy env-path caches (single-account fast path; semantics unchanged).
_last_env_value: str | None = object()  # type: ignore[assignment]
_cached_names: list[str] = []
_cached_pattern: re.Pattern | None = None

# Per-tenant compiled-pattern cache, keyed by the resolved names tuple. The key
# fully determines the value, so this is a keyed cache (sanctioned pattern),
# NOT shared mutable tenant state.
_pattern_by_names: dict[tuple[str, ...], re.Pattern] = {}


def set_tenant_assistant_name(name: str | None) -> contextvars.Token:
  """Bind the current (async) context to *name* as the tenant's assistant
  identity until :func:`reset_tenant_assistant_name`. Pass ``None`` to select
  the legacy env-based identity (single-account)."""
  return _tenant_assistant_name.set(name)


def reset_tenant_assistant_name(token: contextvars.Token) -> None:
  """Undo a previous :func:`set_tenant_assistant_name` using its token."""
  _tenant_assistant_name.reset(token)


@contextlib.contextmanager
def tenant_assistant_name_context(name: str | None):
  """Context-manager form of :func:`set_tenant_assistant_name`."""
  token = _tenant_assistant_name.set(name)
  try:
    yield
  finally:
    _tenant_assistant_name.reset(token)


def _names_from_raw(raw: str | None) -> list[str]:
  """Parse a comma-separated assistant-name string (first = primary)."""
  if not raw or not raw.strip():
    return [DEFAULT_ASSISTANT_NAME]
  names = [n.strip() for n in raw.split(",") if n.strip()]
  return names if names else [DEFAULT_ASSISTANT_NAME]


def _parse_assistant_names() -> list[str]:
  """Resolve assistant names: the per-tenant override (if bound) takes
  precedence; otherwise fall back to the cached ``ASSISTANT_NAME`` env value."""
  override = _tenant_assistant_name.get()
  if override is not None:
    return _names_from_raw(override)
  global _last_env_value, _cached_names, _cached_pattern
  raw = config.assistant_name_env()
  if raw == _last_env_value:
    return _cached_names
  _last_env_value = raw
  _cached_pattern = None  # invalidate pattern cache
  _cached_names = _names_from_raw(raw)
  return _cached_names


def assistant_name() -> str:
  """Return the primary bot name (first in comma-separated list)."""
  return _parse_assistant_names()[0]


def assistant_aliases() -> list[str]:
  """Return all bot name aliases (including primary), lowercased."""
  return [n.lower() for n in _parse_assistant_names()]


def assistant_name_pattern() -> re.Pattern:
  """Return compiled regex matching any bot alias (case-insensitive, word boundary)."""
  global _cached_pattern
  names = _parse_assistant_names()  # ensure cache is fresh / override resolved
  if _tenant_assistant_name.get() is not None:
    # Per-tenant override active — use a keyed cache so each tenant's identity
    # compiles its own pattern (no cross-tenant leak via the global cache).
    key = tuple(names)
    pattern = _pattern_by_names.get(key)
    if pattern is None:
      escaped = [re.escape(a) for a in names]
      pattern = re.compile(r"(?i)\b(?:" + "|".join(escaped) + r")\b")
      _pattern_by_names[key] = pattern
    return pattern
  # Legacy env fast path (unchanged).
  if _cached_pattern is not None:
    return _cached_pattern
  escaped = [re.escape(a) for a in names]
  pattern = r"(?i)\b(?:" + "|".join(escaped) + r")\b"
  _cached_pattern = re.compile(pattern)
  return _cached_pattern


def assistant_sender_ref() -> str:
  return ASSISTANT_CONTEXT_SENDER_REF


@dataclass
class WhatsAppMessage:
  timestamp_ms: int
  sender: str  # display name or phone
  context_msg_id: Optional[str] = None
  sender_ref: Optional[str] = None
  sender_is_admin: bool = False
  sender_is_super_admin: bool = False
  text: Optional[str] = None
  media: Optional[str] = None  # e.g., "media", "sticker", "image", "video"
  quoted_message_id: Optional[str] = None
  quoted_sender: Optional[str] = None
  quoted_text: Optional[str] = None
  quoted_media: Optional[str] = None
  quoted_sender_ref: Optional[str] = None
  quoted_sender_is_admin: bool = False
  quoted_sender_is_super_admin: bool = False
  message_id: Optional[str] = None
  role: str = "user"  # "user" | "assistant"


def _context_time_utc_offset_hours() -> float | None:
  raw = config.context_time_utc_offset_raw()
  if raw is None:
    return None
  cleaned = "".join(str(raw).split())
  if not cleaned:
    return None
  try:
    return float(cleaned)
  except (TypeError, ValueError):
    return None


def format_context_time(ts_ms: int) -> str:
  timestamp_seconds = max(ts_ms, 0) / 1000
  utc_offset_hours = _context_time_utc_offset_hours()
  if utc_offset_hours is None:
    return datetime.fromtimestamp(timestamp_seconds).strftime("%H:%M")
  dt = datetime.fromtimestamp(
    timestamp_seconds,
    tz=timezone(timedelta(hours=utc_offset_hours)),
  )
  return dt.strftime("%H:%M")


def _compact(value: Optional[str]) -> str:
  if not value:
    return ""
  return " ".join(value.split())


def _normalize_context_msg_id(value: Optional[str], *, role: str = "user", media: Optional[str] = None) -> str:
  compact = _compact(value).lower()
  if compact in {"system", "pending"}:
    return compact
  if compact.isdigit() and len(compact) == 6:
    # All assistant messages (text and media) keep their real 6-digit
    # contextMsgId so the LLM can reference its own messages for
    # reply, delete, react, etc.
    return compact
  if role == "assistant":
    return "pending"
  return "000000"


def _is_media_stub(text: str) -> bool:
  """Return True if text is a generic <media:...> placeholder that duplicates the [media] prefix.

  Named sticker stubs like <media:sticker=thumbs_up> are NOT suppressed —
  the sticker name is meaningful context for the LLM.
  """
  if not (text.startswith("<media:") and text.endswith(">")):
    return False
  # Keep named sticker stubs (e.g. <media:sticker=thumbs_up>)
  if text.startswith("<media:sticker=") and len(text) > len("<media:sticker=>"):
    return False
  return True


def _message_text(msg: WhatsAppMessage) -> str:
  media_part = f"[{msg.media}]" if msg.media else ""
  text_part = msg.text or ""
  # Named sticker stubs: render as "[sticker] name" instead of raw placeholder
  if msg.media == "sticker" and text_part.startswith("<media:sticker=") and text_part.endswith(">"):
    sticker_name = text_part[len("<media:sticker="):-1]
    if sticker_name:
      return f"[sticker] {sticker_name}"
  # Suppress generic <media:...> placeholders that duplicate the [media] prefix.
  # Only suppress when msg.media is set — without media, the text is the
  # only content and must not be silently dropped.
  if msg.media and _is_media_stub(text_part):
    text_part = ""
  if media_part and text_part:
    return f"{media_part} {text_part}"
  return media_part or text_part or "(empty)"


def _format_role(is_admin: bool, is_super_admin: bool = False) -> str:
  """Format admin role label for display in LLM context."""
  if is_super_admin:
    return "(superadmin)"
  if is_admin:
    return "(admin)"
  return ""


def hydrate_quoted_from_history(msg: WhatsAppMessage, history: Sequence[WhatsAppMessage]) -> None:
  """Look up the quoted message in history and fill in missing quoted fields.

  Mutates msg in place. Used by format_history() and by the processing
  pipeline to hydrate REPLYING TO lines with complete info when the
  original payload didn't carry them.
  """
  if not msg.quoted_message_id:
    return
  q_id = msg.quoted_message_id
  # Don't look up "system" or "pending" context IDs
  if q_id in ("system", "pending"):
    return
  found = None
  # Primary search: by context_msg_id
  for hist_msg in reversed(history):
    if hist_msg.context_msg_id == q_id:
      found = hist_msg
      break
  # Fallback: search by message_id for cases where contextMsgId is still
  # "pending" (e.g. bot messages awaiting send_ack) but the quoted message
  # carries the raw WhatsApp message ID.
  if found is None and msg.quoted_message_id:
    for hist_msg in reversed(history):
      if hist_msg.message_id and hist_msg.message_id == msg.quoted_message_id:
        found = hist_msg
        break
  if found is not None:
    _hydrate_from_hist_msg(msg, found)


def _hydrate_from_hist_msg(msg: WhatsAppMessage, hist_msg: WhatsAppMessage) -> None:
  """Hydrate missing quoted fields from a matched history entry."""
  if not msg.quoted_sender:
    msg.quoted_sender = hist_msg.sender
  if not msg.quoted_sender_ref:
    msg.quoted_sender_ref = hist_msg.sender_ref
  if not msg.quoted_text and hist_msg.text:
    msg.quoted_text = hist_msg.text
  if not msg.quoted_media and hist_msg.media:
    msg.quoted_media = hist_msg.media
  # Always hydrate admin flags from history if the sender matches
  if hist_msg.sender_is_admin and not msg.quoted_sender_is_admin:
    msg.quoted_sender_is_admin = True
  if hist_msg.sender_is_super_admin and not msg.quoted_sender_is_super_admin:
    msg.quoted_sender_is_super_admin = True
  # If the quoted message is from the assistant, override sender fields
  # with the canonical bot name so that JIDs or senderRefs from the raw
  # WA payload are replaced with a human-readable display.
  if hist_msg.role == "assistant":
    msg.quoted_sender = hist_msg.sender
    msg.quoted_sender_ref = hist_msg.sender_ref or assistant_sender_ref()


def format_history(messages: Iterable[WhatsAppMessage], history: list[WhatsAppMessage] | None = None, trim_quoted: bool = False) -> str:
  # ponytail: trim_quoted drops the quoted sender+text on older history and
  # keeps only the [#id] pointer — the quoted line is usually already in the
  # transcript at that id, so re-printing it is redundant tokens. Caveat: if
  # the quoted message is older than HISTORY_LIMIT it is NOT in the transcript
  # and its content is lost; flip this off (or keep q_content) if that bites.
  lines: list[str] = []
  # Materialize for reverse lookup during hydration, guarding against
  # one-shot iterators: if no explicit history list is provided we
  # must consume the iterator into a list first, then iterate the list.
  if history is not None:
    history_list = history
    msg_iter = messages
  else:
    history_list = list(messages)
    msg_iter = history_list  # type: ignore[assignment]
  for msg in msg_iter:
    # Hydrate missing quoted fields from history
    if msg.quoted_message_id:
      hydrate_quoted_from_history(msg, history_list)
    context_msg_id = _normalize_context_msg_id(msg.context_msg_id, role=msg.role, media=msg.media)
    time = format_context_time(msg.timestamp_ms)

    # System-role messages are bridge-injected events (e.g. [SUBTASK FINISHED],
    # /reset markers) — render them with a clearly-distinct prefix so the LLM
    # cannot confuse them for user content. Without this, format_history used
    # to flatten them as "system (unknown): ..." which looked like a regular
    # user message and caused the model to ignore the signal.
    if msg.role == "system":
      lines.append(f"[#system] {time}")
      message_text = _message_text(msg)
      # Indent multi-line system payloads (e.g. SUBTASK FINISHED reports) so
      # they read as a single coherent block rather than being mistaken for
      # several separate chat lines.
      indented = message_text.replace("\n", "\n  ")
      lines.append(f"SYSTEM: {indented}")
      lines.append("")
      continue

    if msg.role == "assistant":
      sender = assistant_name()
      sender_ref = assistant_sender_ref()
      role_label = ""  # (You) already identifies bot messages
    else:
      sender = _compact(msg.sender) or "unknown"
      sender_ref = _compact(msg.sender_ref) or "unknown"
      role_label = _format_role(msg.sender_is_admin, msg.sender_is_super_admin)

    # Header line
    lines.append(f"[#{context_msg_id}] {time}")
    
    # Reply line
    if msg.quoted_message_id and trim_quoted:
      lines.append(f"REPLYING TO [#{_normalize_context_msg_id(msg.quoted_message_id)}]")
    elif msg.quoted_message_id:
      q_id = _normalize_context_msg_id(msg.quoted_message_id)
      q_sender = _compact(msg.quoted_sender) or "someone"
      q_sender_ref = _compact(msg.quoted_sender_ref) or None
      q_text = _compact(msg.quoted_text) or ""
      q_media = _compact(msg.quoted_media)

      # Build sender display: "Name (ref) (role)"
      q_role_label = ""
      if msg.quoted_sender_is_super_admin:
        q_role_label = " (superadmin)"
      elif msg.quoted_sender_is_admin:
        q_role_label = " (admin)"

      if q_sender_ref:
        q_sender_display = f"{q_sender} ({q_sender_ref}){q_role_label}"
      else:
        q_sender_display = f"{q_sender}{q_role_label}"

      # Suppress <media:...> stub in quoted text when quoted_media already
      # carries the type — identical to the logic in _message_text().
      if q_media and _is_media_stub(q_text):
        q_text = ""

      q_content = f"[{q_media}] " if q_media else ""
      if q_text:
        q_content += f'"{q_text}"'
      elif not q_media:
        q_content = "(empty)"

      lines.append(f"REPLYING TO [#{q_id}] {q_sender_display}: {q_content}")

    # Content line
    message_text = _message_text(msg)
    role_suffix = f" {role_label}" if role_label else ""
    lines.append(f"{sender} ({sender_ref}){role_suffix}: {message_text}")
    lines.append("") # Empty line between messages

  return "\n".join(lines).strip()
