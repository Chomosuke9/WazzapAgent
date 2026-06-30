"""Visual media processing for the LLM pipeline (moved into ``bridge.media``).

This module previously lived at ``bridge/media.py``. Step 08 introduced the
``bridge/media/`` package for media + sticker resolution; this file is the
former ``media.py`` relocated verbatim (only the relative-import depth and
``PROJECT_ROOT`` parent index are adjusted for the new nesting). Public symbols
are re-exported from ``bridge.media`` so existing imports
(``from ..media import build_visual_parts``) keep working unchanged.
"""
from __future__ import annotations

import base64
import mimetypes
import os
from pathlib import Path

from ..log import setup_logging

from ..config import _parse_positive_int

logger = setup_logging()
PROJECT_ROOT = Path(__file__).resolve().parents[3]


def llm1_media_enabled() -> bool:
  raw = os.getenv("LLM1_ENABLE_MEDIA_INPUT")
  if raw is None:
    return False
  return raw.strip().lower() in {"1", "true", "yes", "on"}


def llm2_media_enabled() -> bool:
  raw = os.getenv("LLM2_ENABLE_MEDIA_INPUT")
  if raw is None:
    return True
  return raw.strip().lower() in {"1", "true", "yes", "on"}


def media_max_items() -> int:
  return _parse_positive_int(os.getenv("LLM_MEDIA_MAX_ITEMS"), 2)


def media_max_bytes() -> int:
  return _parse_positive_int(os.getenv("LLM_MEDIA_MAX_BYTES"), 5 * 1024 * 1024)


def _resolve_local_path(path_value: object) -> Path | None:
  if not isinstance(path_value, str) or not path_value.strip():
    return None
  path_obj = Path(path_value).expanduser()
  if path_obj.is_absolute():
    return path_obj.resolve()
  return (PROJECT_ROOT / path_obj).resolve()


def _is_visual_attachment(att: dict) -> bool:
  kind = str(att.get("kind") or "").lower()
  mime = str(att.get("mime") or "").lower()
  if kind in {"image", "sticker"}:
    return True
  # Documents with a jpegThumbnail can be shown to the LLM as a preview.
  if kind == "document" and att.get("jpegThumbnail"):
    return True
  return mime.startswith("image/")


def _guess_mime(att: dict, file_path: Path) -> str:
  mime = str(att.get("mime") or "").strip().lower()
  if mime.startswith("image/"):
    return mime

  guessed, _ = mimetypes.guess_type(file_path.name)
  if guessed and guessed.startswith("image/"):
    return guessed

  kind = str(att.get("kind") or "").strip().lower()
  if kind == "sticker":
    return "image/webp"
  return "image/jpeg"


def _attachment_label(att: dict) -> str:
  kind = str(att.get("kind") or "").strip().lower()
  if kind == "sticker":
    return "sticker"
  if kind == "document":
    return "document"
  return "image"


def _placeholder_for_large_media(label: str, file_name: str) -> str:
  safe_name = file_name.replace("\n", " ").strip() or "unknown"
  return f"<{label}:too_large:{safe_name}>"


def build_visual_parts(
  payload: dict | None,
  *,
  max_items: int | None = None,
  max_bytes: int | None = None,
) -> tuple[list[dict[str, object]], list[str]]:
  if not payload:
    logger.debug('build_visual_parts: no payload, returning empty')
    return [], []

  attachments = payload.get("attachments") or []
  if not attachments:
    logger.debug('build_visual_parts: no attachments in payload, returning empty')
    return [], []

  item_limit = max_items or media_max_items()
  size_limit = max_bytes or media_max_bytes()
  parts: list[dict[str, object]] = []
  notes: list[str] = []
  skipped_count = 0

  for att in attachments:
    if not isinstance(att, dict):
      continue
    if not _is_visual_attachment(att):
      continue
    if len(parts) >= item_limit:
      skipped_count += 1
      continue

    path_obj = _resolve_local_path(att.get("path"))
    label = _attachment_label(att)
    # Prefer the original filename (e.g. "Report.pdf") over the generated
    # one (e.g. "ABC123_document.pdf") so the LLM sees a human-readable name.
    file_name = str(
      att.get("originalFileName")
      or att.get("fileName")
      or (path_obj.name if path_obj else "unknown")
    )
    kind = str(att.get("kind") or "").strip().lower()

    # --- Document thumbnail path ---
    # Documents are not image files, but WhatsApp sends a jpegThumbnail
    # (base64-encoded JPEG) that gives a visual preview (e.g. first page
    # of a PDF).  Use that thumbnail directly instead of reading the
    # (binary) document file.  The thumbnail is embedded in the payload
    # so no local file access is needed.
    if kind == "document" and att.get("jpegThumbnail"):
      thumb_b64 = att["jpegThumbnail"]
      if isinstance(thumb_b64, str) and thumb_b64:
        mime = "image/jpeg"
        data_url = f"data:{mime};base64,{thumb_b64}"
        parts.append({"type": "image_url", "image_url": {"url": data_url}})
        notes.append(f"{label} thumbnail attached: {file_name}")
        continue

    # --- Regular image / sticker path ---
    # For images and stickers we need the local file on disk.
    if path_obj is None or not path_obj.exists() or not path_obj.is_file():
      notes.append(f"{label} skipped (missing file: {file_name})")
      skipped_count += 1
      continue

    file_size = path_obj.stat().st_size
    if file_size > size_limit:
      placeholder = _placeholder_for_large_media(label, file_name)
      notes.append(
        f"{label} placeholder: {placeholder} (size={file_size}B limit={size_limit}B)"
      )
      continue

    try:
      blob = path_obj.read_bytes()
    except Exception:
      notes.append(f"{label} skipped (read failed: {file_name})")
      skipped_count += 1
      continue

    mime = _guess_mime(att, path_obj)
    data_url = f"data:{mime};base64,{base64.b64encode(blob).decode('ascii')}"
    parts.append({"type": "image_url", "image_url": {"url": data_url}})
    notes.append(f"{label} attached: {file_name}")

  if skipped_count > 0:
    notes.append(f"{skipped_count} visual attachment(s) skipped")

  return parts, notes


def redact_multimodal_content(content: object) -> object:
  if isinstance(content, str):
    return content
  if not isinstance(content, list):
    return content

  redacted: list[object] = []
  for part in content:
    if not isinstance(part, dict):
      redacted.append(part)
      continue

    if part.get("type") != "image_url":
      redacted.append(part)
      continue

    image_url = part.get("image_url")
    url = image_url.get("url") if isinstance(image_url, dict) else None
    if isinstance(url, str) and url.startswith("data:"):
      prefix = url.split(",", 1)[0]
      redacted.append(
        {
          "type": "image_url",
          "image_url": {
            "url": f"{prefix},<base64-redacted>",
          },
        }
      )
      continue

    redacted.append(part)

  return redacted
