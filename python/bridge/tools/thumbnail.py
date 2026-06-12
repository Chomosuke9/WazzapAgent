"""Document thumbnail generation for WhatsApp previews.

WhatsApp displays a small preview/thumbnail for document attachments only
when a ``jpegThumbnail`` field is provided in the protocol message.  Without
it, non-PDF documents show a blank white rectangle.

Since LibreOffice is only available inside the WazzapSubAgents Docker
container (not on the host), and to keep things simple and dependency-free,
every document type gets a **placeholder icon** — a coloured square with the
file extension or a short MIME label centred in white text.  This is fast,
zero-dependency (only Pillow for drawing the icon), and gives the user a
clear visual cue about the file type.

All thumbnails are produced as small JPEG buffers suitable for inclusion in
the Baileys ``DocumentMessage.jpegThumbnail`` field.
"""
from __future__ import annotations

import io
import os
from typing import Optional

from PIL import Image, ImageDraw, ImageFont

from ..log import setup_logging

logger = setup_logging()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# WhatsApp renders the document thumbnail at roughly 300×300 logical pixels.
# We produce a slightly larger image and let the client scale it down.
_THUMB_SIZE = 400

# JPEG quality for thumbnail output.  75 is a good balance between quality
# and size for a 400×400 image.
_THUMB_JPEG_QUALITY = 75

# ---------------------------------------------------------------------------
# MIME-type → placeholder icon colour + label
# ---------------------------------------------------------------------------

_PLACEHOLDER_CONFIG: dict[str, tuple[str, str]] = {
  # mime_type_prefix  → (fill_colour_hex, short_label)
  "application/pdf":                                        ("#E53935", "PDF"),
  "application/vnd.openxmlformats-officedocument.wordprocessingml": ("#2B579A", "DOCX"),
  "application/vnd.openxmlformats-officedocument.spreadsheetml":    ("#217346", "XLSX"),
  "application/vnd.openxmlformats-officedocument.presentationml":    ("#D24726", "PPTX"),
  "application/vnd.oasis.opendocument.text":                        ("#0E7FC2", "ODT"),
  "application/vnd.oasis.opendocument.spreadsheet":                  ("#0E7FC2", "ODS"),
  "application/vnd.oasis.opendocument.presentation":                 ("#0E7FC2", "ODP"),
  "application/msword":              ("#2B579A", "DOC"),
  "application/vnd.ms-excel":         ("#217346", "XLS"),
  "application/vnd.ms-powerpoint":    ("#D24726", "PPT"),
  "application/rtf":                 ("#7B5B3A", "RTF"),
  "text/plain":                      ("#6B7280", "TXT"),
  "text/csv":                         ("#217346", "CSV"),
  "text/html":                        ("#E44D26", "HTML"),
  "application/json":                 ("#6B7280", "JSON"),
  "application/zip":                   ("#6B7280", "ZIP"),
  "application/x-7z-compressed":     ("#6B7280", "7Z"),
  "application/vnd.rar":              ("#6B7280", "RAR"),
  "application/gzip":                 ("#6B7280", "GZ"),
  "application/x-tar":                ("#6B7280", "TAR"),
  "image/":                           ("#9333EA", "IMG"),
}

# ---------------------------------------------------------------------------
# Helper: generate a solid-colour placeholder icon with a short label
# ---------------------------------------------------------------------------

def _hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
  """Convert ``#RRGGBB`` to ``(R, G, B)``."""
  h = hex_color.lstrip("#")
  return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def _generate_placeholder(mime: str | None, ext: str) -> bytes:
  """Return a JPEG thumbnail buffer for any file type.

  The icon is a solid-colour square with the file extension (or a short
  MIME-type label) centred in white text on a coloured background.
  """
  # Guard against None MIME — detect_kind should always return a string,
  # but defensive coding prevents crashes if that invariant breaks.
  safe_mime = mime or ""
  # Find a matching placeholder config key (exact match first, then prefix)
  config_entry = _PLACEHOLDER_CONFIG.get(safe_mime)
  if config_entry is None:
    for key, val in _PLACEHOLDER_CONFIG.items():
      if safe_mime.startswith(key):
        config_entry = val
        break

  if config_entry:
    fill_hex, label = config_entry
  else:
    fill_hex, label = "#6B7280", ext.upper()[:5] if ext else "FILE"

  bg_color = _hex_to_rgb(fill_hex)

  img = Image.new("RGB", (_THUMB_SIZE, _THUMB_SIZE), bg_color)
  draw = ImageDraw.Draw(img)

  # Try to use a TrueType font; fall back to the default bitmap font.
  font_size = max(24, _THUMB_SIZE // (len(label) + 1))
  font = _try_load_font(font_size)

  # Centre the label text
  bbox = draw.textbbox((0, 0), label, font=font)
  tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
  x = (_THUMB_SIZE - tw) // 2
  y = (_THUMB_SIZE - th) // 2
  draw.text((x, y), label, fill="white", font=font)

  buf = io.BytesIO()
  img.save(buf, format="JPEG", quality=_THUMB_JPEG_QUALITY)
  return buf.getvalue()


# ---------------------------------------------------------------------------
# Font loading (DejaVu Sans preferred; falls back to Pillow default)
# ---------------------------------------------------------------------------

_FONT_PATHS = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
]


def _try_load_font(size: int) -> ImageFont.FreeTypeFont:
  """Attempt to load a TrueType font at the given size; fall back to default."""
  for fp in _FONT_PATHS:
    try:
      return ImageFont.truetype(fp, size=size)
    except (OSError, IOError):
      continue
  return ImageFont.load_default()


# ---------------------------------------------------------------------------
# Core: generate_document_thumbnail
# ---------------------------------------------------------------------------

def generate_document_thumbnail(
  file_path: str,
  mime: str,
) -> Optional[bytes]:
  """Generate a JPEG thumbnail buffer for *file_path*.

  Always returns a **placeholder icon** — a coloured square with the file
  type label (PDF, DOCX, XLSX, etc.) centred in white text.  This is fast,
  has no external dependencies beyond Pillow, and works for every document
  type without needing LibreOffice or pypdfium2.

  Returns ``None`` if thumbnail generation fails for any reason (missing
  Pillow, etc.).  The caller should simply send the document without a
  thumbnail in that case.
  """
  if not file_path or not os.path.isfile(file_path):
    return None

  ext = os.path.splitext(file_path)[1].lstrip(".").lower()

  try:
    return _generate_placeholder(mime, ext)
  except Exception:
    logger.debug(
      "generate_document_thumbnail: failed for %s (mime=%s)",
      file_path, mime,
      exc_info=True,
    )
    return None
