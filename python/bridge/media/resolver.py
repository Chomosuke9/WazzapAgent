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

import mimetypes
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

  Attachments are grouped by their OWN owning message's ``contextMsgId``.
  After a burst merge (see ``_merge_payload_attachments``) one payload can
  carry attachments from several messages, so keying everything under the
  payload's top-level ``contextMsgId`` would mis-file them and break later
  quoted-image reuse / sub-agent resolution. Each merged attachment is stamped
  with its own ``contextMsgId``; un-stamped attachments (single-message
  payloads) fall back to the payload's id, preserving the prior behaviour.
  """
  payload_ctx_id = payload.get("contextMsgId")
  chat_id = payload.get("chatId")
  atts = payload.get("attachments") or []
  if not chat_id:
    return
  paths_by_ctx: dict[str, list] = {}
  for att in atts:
    if not isinstance(att, dict):
      continue
    p = att.get("path")
    if not p:
      continue
    att_ctx_id = att.get("contextMsgId") or payload_ctx_id
    if not att_ctx_id:
      continue
    paths_by_ctx.setdefault(att_ctx_id, []).append({
      "kind": str(att.get("kind", "")).lower(),
      "mime": att.get("mime", ""),
      "fileName": att.get("fileName", ""),
      "originalFileName": att.get("originalFileName") or None,
      "jpegThumbnail": att.get("jpegThumbnail") or None,
      "path": p,
      "received_at": time.time(),
    })
  for att_ctx_id, paths in paths_by_ctx.items():
    if paths:
      media_paths_by_chat.setdefault(chat_id, {})[att_ctx_id] = paths


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
  # The current payload may already carry its own visual attachment(s); we
  # still append the quoted message's media on top (deduped by path) so a reply
  # like "make this a sticker" + a new image, or simply a reply TO a
  # sticker/image, both reach the model. (Previously the current visual caused
  # an early return that dropped the replied-to media entirely.)
  atts = list(payload.get("attachments") or [])

  # Check quoted message for previously tracked media
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
  # On Windows, ``mimetypes`` consults the registry before its built-in table.
  # Some hosts register .webp as image/jpeg, which makes quoted stickers reach
  # vision providers with a MIME type that does not match their bytes.
  if os.path.splitext(file_path)[1].lower() == ".webp":
    return "image/webp"
  guessed = mimetypes.guess_type(file_path)[0]
  return guessed or "image/jpeg"


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
  payload_ctx_id = payload.get("contextMsgId")
  payload_message_id = payload.get("messageId")
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
    # An attachment may have been merged in from an EARLIER burst message
    # (see ``_merge_payload_attachments``), so the payload's top-level
    # contextMsgId/messageId is NOT necessarily this attachment's owner.
    # Prefer the attachment's own stamped ids; fall back to the payload's
    # for un-merged single-message payloads (which carry no per-att id).
    att_ctx_id = att.get("contextMsgId") or payload_ctx_id
    att_message_id = att.get("messageId") or payload_message_id
    try:
      result = await sock.download_media(
        chat_id, context_msg_id=att_ctx_id, message_id=att_message_id
      )
    except Exception as err:  # NotFoundError / TimeoutError / etc.
      logger.info(
        "materialize_visual_media: download failed ctx=%s: %s",
        att_ctx_id, err, extra={"chat_id": chat_id},
      )
      continue
    path = result.get("path") if isinstance(result, dict) else None
    if path:
      att["path"] = path
      if isinstance(result, dict) and result.get("mime") and not att.get("mime"):
        att["mime"] = result["mime"]
      changed = True
  if changed:
    _store_media_path(media_paths_by_chat, payload)


async def materialize_quoted_media(sock, payload: dict, media_paths_by_chat: dict) -> None:
  """Lazy media: download the REPLIED-TO message's visual bytes on demand.

  A user can reply to an image/sticker that arrived earlier and was never
  downloaded (lazy media forwards metadata only). The quoted payload carries
  only the quoted ``contextMsgId``; if no file is on disk for it yet, fetch it
  so :func:`_resolve_quoted_media_attachments` can hand it to the vision model.
  Failures degrade gracefully (the reply simply has no resolved media).
  """
  if sock is None:
    return
  chat_id = payload.get("chatId")
  quoted = payload.get("quoted") or {}
  quoted_ctx_id = quoted.get("contextMsgId")
  quoted_message_id = quoted.get("messageId")
  if not chat_id or not (quoted_ctx_id or quoted_message_id):
    return
  # Already on disk? Nothing to do.
  existing = media_paths_by_chat.get(chat_id, {}).get(quoted_ctx_id) if quoted_ctx_id else None
  if isinstance(existing, list) and any(
    isinstance(e, dict) and e.get("path") and os.path.isfile(e["path"]) for e in existing
  ):
    return
  if isinstance(existing, str) and os.path.isfile(existing):
    return
  try:
    result = await sock.download_media(
      chat_id, context_msg_id=quoted_ctx_id, message_id=quoted_message_id
    )
  except Exception as err:  # NotFoundError / TimeoutError / proto evicted
    logger.info(
      "materialize_quoted_media: download failed ctx=%s: %s",
      quoted_ctx_id, err, extra={"chat_id": chat_id},
    )
    return
  path = result.get("path") if isinstance(result, dict) else None
  if not path or not os.path.isfile(path):
    return
  store_ctx_id = quoted_ctx_id or quoted_message_id
  media_paths_by_chat.setdefault(chat_id, {})[store_ctx_id] = [{
    "kind": str(result.get("kind", "")).lower(),
    "mime": result.get("mime", ""),
    "fileName": result.get("fileName", ""),
    "originalFileName": result.get("originalFileName") or None,
    "jpegThumbnail": result.get("jpegThumbnail") or None,
    "path": path,
    "received_at": time.time(),
  }]
  logger.info(
    "materialize_quoted_media: downloaded quoted ctx=%s kind=%s -> %s",
    store_ctx_id, result.get("kind"), path, extra={"chat_id": chat_id},
  )


async def materialize_media_for_subagent(
  sock,
  chat_id: str,
  ctx_ids,
  media_paths_by_chat: dict,
  history=None,
) -> None:
  """Ensure the media for ``ctx_ids`` is on disk so it can be sent to the
  sub-agent.

  Unlike :func:`materialize_visual_media` — which only downloads
  ``image``/``sticker`` kinds because that is all a vision model needs —
  the sub-agent operates on ANY attachment kind: PDFs, ``.docx`` /
  ``.xlsx`` / ``.pptx``, plain text, audio, video, archives, etc.

  With lazy media (feature 8) inbound forwards attachment metadata WITHOUT
  downloading the bytes (``path: None``, ``pending: True``), and the only
  on-demand fetch path (``materialize_visual_media``) deliberately skips
  non-visual kinds. The result was that when LLM2 delegated a document to
  the sub-agent via ``execute_subtask``, the file's bytes were never
  downloaded, ``media_paths_by_chat`` held no usable path for it, and the
  sub-agent silently received nothing — the user-visible symptom being
  "the bot ignored the file I sent".

  For each ctx_id that does not already resolve to a real file on disk,
  download it on demand (any kind) and record the resolved path via the
  same shape :func:`_store_media_path` uses, so the caller's existing
  resolution loop finds it. Failures degrade gracefully: the ctx_id is
  left unresolved and simply omitted from the sub-agent inputs, exactly as
  before this fix.

  When ``history`` is supplied, ctx_ids that history knows are text-only
  (their :class:`~bridge.history.WhatsAppMessage` carries no ``media`` kind)
  are skipped WITHOUT a download attempt: requesting their bytes only makes
  the gateway reply ``invalid_target: unsupported media type``, which used
  to surface as a misleading "download failed" log for what is really just
  an LLM2 reference to a plain-text message (e.g. the user's instruction).
  ctx_ids absent from history (evicted from the bounded deque) stay eligible
  so genuinely old media can still be fetched on demand.
  """
  if sock is None or not chat_id or not ctx_ids:
    return

  # ctx_ids that history positively knows are text-only (present in history
  # but with no ``media`` kind). Only these are skipped — a ctx_id that is
  # NOT in history is left eligible for a download attempt.
  text_only_ctx_ids: set = set()
  if history is not None:
    seen_ctx_ids: set = set()
    media_ctx_ids: set = set()
    for msg in history:
      cid = getattr(msg, "context_msg_id", None)
      if not cid:
        continue
      seen_ctx_ids.add(cid)
      if getattr(msg, "media", None):
        media_ctx_ids.add(cid)
    text_only_ctx_ids = seen_ctx_ids - media_ctx_ids

  for cid in ctx_ids:
    if not cid:
      continue
    # History says this message carries no attachment — nothing to download.
    if cid in text_only_ctx_ids:
      continue
    # Skip ctx_ids whose media is already materialized on disk.
    existing = media_paths_by_chat.get(chat_id, {}).get(cid)
    if isinstance(existing, list):
      if any(
        isinstance(e, dict) and e.get("path") and os.path.isfile(e["path"])
        for e in existing
      ):
        continue
    elif isinstance(existing, str) and os.path.isfile(existing):
      continue

    try:
      result = await sock.download_media(chat_id, context_msg_id=cid)
    except Exception as err:  # NotFoundError / TimeoutError / proto evicted
      logger.info(
        "materialize_media_for_subagent: download failed ctx=%s: %s",
        cid, err, extra={"chat_id": chat_id},
      )
      continue

    path = result.get("path") if isinstance(result, dict) else None
    if not path or not os.path.isfile(path):
      logger.info(
        "materialize_media_for_subagent: no file returned for ctx=%s",
        cid, extra={"chat_id": chat_id},
      )
      continue

    media_paths_by_chat.setdefault(chat_id, {})[cid] = [{
      "kind": str(result.get("kind", "")).lower(),
      "mime": result.get("mime", ""),
      "fileName": result.get("fileName", ""),
      "originalFileName": result.get("originalFileName") or None,
      "jpegThumbnail": result.get("jpegThumbnail") or None,
      "path": path,
      "received_at": time.time(),
    }]
    logger.info(
      "materialize_media_for_subagent: downloaded ctx=%s kind=%s -> %s",
      cid, result.get("kind"), path, extra={"chat_id": chat_id},
    )
