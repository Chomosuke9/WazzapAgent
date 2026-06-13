"""Media / sticker resolution helpers (Step 08 extraction).

These functions were previously module-level helpers at the top of
``bridge/session.py`` (lines ~193–388). They are stateless / parameterised:
they operate on the per-chat ``media_paths_by_chat`` dict that is passed in by
the caller, so the per-account mutable state stays owned by the
:class:`~bridge.session.AgentSession` instance (no module-level mutable state is
introduced here). Behaviour is byte-for-byte identical to the original
closures; only their home moved.
"""
from __future__ import annotations

import os
import time
from collections import deque

from ..history import (
  WhatsAppMessage,
  assistant_name,
  assistant_sender_ref,
)
from ..log import setup_logging

logger = setup_logging()


def _parse_sticker_args(args: str) -> tuple[str | None, str | None]:
  """Parse '/sticker upper#lower' args → (upper_text, lower_text). Either may be None."""
  if "#" in args:
    upper, _, lower = args.partition("#")
    return upper.strip() or None, lower.strip() or None
  return args.strip() or None, None


def _store_media_path(media_paths_by_chat: dict, payload: dict) -> None:
  """Record attachment file paths keyed by (chat_id, context_msg_id) for later lookup.

  Stores ALL attachment kinds (image, sticker, document, audio, video),
  not just visual media. This enables LLM2 to reference any file path
  when delegating tasks to the sub-agent.
  """
  ctx_id = payload.get("contextMsgId")
  chat_id = payload.get("chatId")
  atts = payload.get("attachments") or []
  if not ctx_id or not chat_id:
    return
  paths = []
  for att in atts:
    if isinstance(att, dict):
      p = att.get("path")
      if p:
        paths.append({
          "kind": str(att.get("kind", "")).lower(),
          "mime": att.get("mime", ""),
          "fileName": att.get("fileName", ""),
          "originalFileName": att.get("originalFileName") or None,
          "jpegThumbnail": att.get("jpegThumbnail") or None,
          "path": p,
          "received_at": time.time(),
        })
  if paths:
    media_paths_by_chat.setdefault(chat_id, {})[ctx_id] = paths


def _cleanup_stale_media_paths(media_paths_by_chat: dict, max_age_seconds: float = 86400.0) -> int:
  """Remove media path entries older than max_age_seconds. Returns count removed."""
  now = time.time()
  removed = 0
  for chat_id in list(media_paths_by_chat.keys()):
    ctx_map = media_paths_by_chat[chat_id]
    for ctx_id in list(ctx_map.keys()):
      entries = ctx_map[ctx_id]
      if isinstance(entries, list) and entries:
        if all(now - e.get("received_at", now) > max_age_seconds for e in entries):
          del ctx_map[ctx_id]
          removed += 1
    if not ctx_map:
      del media_paths_by_chat[chat_id]
  return removed


def _resolve_quoted_media_attachments(
  media_paths_by_chat: dict,
  payload: dict,
  chat_id: str,
) -> list[dict]:
  """Resolve media attachments from the quoted message and the current payload.

  If the current payload already has visual attachments, return those.
  Otherwise, if the quoted message had previously-tracked media files,
  build attachment dicts from the stored paths and return them.
  """
  # First: check if current payload already has visual attachments
  atts = list(payload.get("attachments") or [])
  visual_kinds = {"image", "sticker"}
  has_visual = any(
    isinstance(att, dict) and (
      str(att.get("kind", "")).lower() in visual_kinds
      or (str(att.get("kind", "")).lower() == "document" and att.get("jpegThumbnail"))
    )
    for att in atts
  )
  if has_visual:
    logger.debug(
      "resolve_quoted_media: current payload has %d visual attachment(s), using those",
      sum(1 for a in atts if isinstance(a, dict) and str(a.get("kind", "")).lower() in visual_kinds),
      extra={"chat_id": chat_id},
    )
    return atts  # Already has visual attachments from the current message

  # Second: check quoted message for previously tracked media
  quoted = payload.get("quoted") or {}
  quoted_ctx_id = quoted.get("contextMsgId")
  if not quoted_ctx_id:
    logger.debug(
      "resolve_quoted_media: no current visual attachments and no quoted contextMsgId",
      extra={"chat_id": chat_id},
    )
    return atts

  stored = media_paths_by_chat.get(chat_id, {}).get(quoted_ctx_id)
  if not stored:
    logger.debug(
      "resolve_quoted_media: no stored media for quoted contextMsgId=%s",
      quoted_ctx_id,
      extra={"chat_id": chat_id},
    )
    return atts

  # stored can be a list of dicts (new format) or a single string path (legacy)
  resolved = []
  if isinstance(stored, list):
    for entry in stored:
      if isinstance(entry, dict) and entry.get("path") and os.path.isfile(entry["path"]):
        resolved.append({
          "kind": entry.get("kind", "image"),
          "mime": entry.get("mime") or _guess_mime_from_path(entry["path"]),
          "fileName": entry.get("fileName") or os.path.basename(entry["path"]),
          "originalFileName": entry.get("originalFileName") or None,
          "jpegThumbnail": entry.get("jpegThumbnail") or None,
          "path": entry["path"],
        })
  elif isinstance(stored, str) and os.path.isfile(stored):
    resolved.append({
      "kind": "sticker" if stored.lower().endswith(".webp") else "image",
      "mime": _guess_mime_from_path(stored),
      "fileName": os.path.basename(stored),
      "originalFileName": None,
      "jpegThumbnail": None,
      "path": stored,
    })

  if not resolved:
    logger.debug(
      "resolve_quoted_media: stored media found but files missing on disk",
      extra={"chat_id": chat_id, "quoted_ctx_id": quoted_ctx_id},
    )
    return atts

  logger.info(
    "resolve_quoted_media: resolving %d visual attachment(s) from quoted message (contextMsgId=%s)",
    len(resolved),
    quoted_ctx_id,
    extra={"chat_id": chat_id},
  )
  return atts + resolved


def _guess_mime_from_path(file_path: str) -> str:
  """Guess MIME type from file path."""
  import mimetypes as _mt
  guessed = _mt.guess_type(file_path)[0]
  if guessed and guessed.startswith("image/"):
    return guessed
  if file_path.lower().endswith(".webp"):
    return "image/webp"
  return "image/jpeg"


def _resolve_sticker_media(
  media_paths_by_chat: dict,
  payload: dict,
  chat_id: str,
) -> str | None:
  """Find the media file path to use for sticker creation.
  First checks the current payload's attachments; falls back to the
  quoted message's tracked path (populated when the original image arrived).
  """
  atts = payload.get("attachments") or []
  if atts and isinstance(atts[0], dict):
    path = atts[0].get("path")
    if path and os.path.isfile(path):
      return path
  # Fall back to quoted message's previously tracked path
  quoted = payload.get("quoted") or {}
  quoted_ctx_id = quoted.get("contextMsgId")
  if quoted_ctx_id:
    stored = media_paths_by_chat.get(chat_id, {}).get(quoted_ctx_id)
    # stored can be a list of dicts (new format) or single string (legacy)
    if isinstance(stored, list) and stored and isinstance(stored[0], dict):
      path = stored[0].get("path")
      if path and os.path.isfile(path):
        return path
    elif isinstance(stored, str) and os.path.isfile(stored):
      return stored
  return None


def _append_sticker_log_to_history(
  history: deque,
  log_text: str,
) -> None:
  """Append a synthetic assistant entry to the conversation history for sticker creation."""
  history.append(WhatsAppMessage(
    timestamp_ms=int(time.time() * 1000),
    sender=assistant_name(),
    sender_ref=assistant_sender_ref(),
    text=log_text,
    role="assistant",
  ))


# Visual attachment kinds that genuinely need the file bytes for vision input.
# Documents are excluded: their inline ``jpegThumbnail`` is enough for a preview.
_VISUAL_DOWNLOAD_KINDS = {"image", "sticker"}


async def materialize_visual_media(sock, payload: dict, media_paths_by_chat: dict) -> None:
  """Lazy media (feature 8): download visual attachments that have no local
  ``path`` yet, mutating the payload's attachment dicts in place.

  Inbound now forwards attachment metadata WITHOUT downloading (``path: None``,
  ``pending: True``); this fetches the bytes ON DEMAND — only when the bot is
  actually about to feed them to a vision model. The resolved paths are
  re-recorded via :func:`_store_media_path` so a later quoted-image reuse /
  sticker / sub-agent lookup finds the file. Failures (e.g. the gateway evicted
  the source proto) degrade gracefully: the attachment simply keeps no path and
  ``build_visual_parts`` skips it with a note.
  """
  atts = payload.get("attachments") or []
  if not atts or sock is None:
    return
  chat_id = payload.get("chatId")
  ctx_id = payload.get("contextMsgId")
  message_id = payload.get("messageId")
  if not chat_id:
    return
  changed = False
  for att in atts:
    if not isinstance(att, dict):
      continue
    if att.get("path"):
      continue
    kind = str(att.get("kind") or "").lower()
    if kind not in _VISUAL_DOWNLOAD_KINDS:
      continue
    try:
      result = await sock.download_media(
        chat_id, context_msg_id=ctx_id, message_id=message_id
      )
    except Exception as err:  # NotFoundError / TimeoutError / etc.
      logger.info(
        "materialize_visual_media: download failed ctx=%s: %s",
        ctx_id, err, extra={"chat_id": chat_id},
      )
      continue
    path = result.get("path") if isinstance(result, dict) else None
    if path:
      att["path"] = path
      if isinstance(result, dict) and result.get("mime") and not att.get("mime"):
        att["mime"] = result["mime"]
      changed = True
  if changed and ctx_id:
    _store_media_path(media_paths_by_chat, payload)
