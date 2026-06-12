"""Sub-agent input/output staging and dispatch helpers.

The sub-agent service writes output files under its per-session workdir
(default `/storage/subagent_work/<session_id>/...` when running via the
recommended docker-compose; legacy native runs may use `/tmp/work/...`).
The Node gateway only allows attachments whose real path is inside
`MEDIA_DIR` or `STICKERS_DIR` (see
`src/mediaHandler.js::resolveAllowedAttachmentPath`). To satisfy that sandbox
without weakening it, we copy each output file into

    <MEDIA_DIR>/subagent_out/<session_id>/<basename>

before dispatching it to WhatsApp. Defense in depth — Node still validates
the final path.

This module also stages **input** files: WhatsApp media that LLM2 wants the
sub-agent to operate on first gets copied into

    <SUBAGENT_INPUT_STAGING_DIR>/<session_id>/<basename>

before being passed to `/execute`. The path must be reachable by the
sub-agent process. In the docker-compose contract both sides bind-mount
`/storage` (set ``SUBAGENT_INPUT_STAGING_DIR=/storage/subagent_in``); for
native deployments the default is ``<project_root>/data/subagent_in``.

This module:
  - Stages output files into the Node sandbox dir, dropping files that are
    missing or larger than ``MAX_FILE_SIZE_BYTES``.
  - Stages input files into the cross-process exchange dir.
  - Detects the WhatsApp attachment ``kind`` from the file's MIME type.
  - Renders a human-readable file list to embed into the
    ``[SUBTASK FINISHED]`` system message so LLM2 can reference the files
    naturally in its text reply.
"""
from __future__ import annotations

import base64
import mimetypes
import os
import shutil

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from ..log import setup_logging
from .config import media_dir_env, subagent_input_staging_dir_env

try:
  from ..tools.thumbnail import generate_document_thumbnail
except Exception:
  # Allow the module to be imported even if thumbnail dependencies
  # are missing or thumbnail.py itself raises during import —
  # thumbnails will just be skipped.
  generate_document_thumbnail = None  # type: ignore[assignment]

logger = setup_logging()

# 200 MB per file. Above this we drop the file rather than risk a WhatsApp
# rejection or a slow upload.
MAX_FILE_SIZE_BYTES = 200 * 1024 * 1024

def _project_root() -> Path:
  # python/bridge/subagent/output.py → up four levels = repo root
  return Path(__file__).resolve().parent.parent.parent.parent

def _media_dir() -> Path:
  raw = media_dir_env()
  if raw:
    return Path(raw).expanduser().resolve()
  return (_project_root() / "data" / "media").resolve()

def staging_root() -> Path:
  """Root directory for staged sub-agent outputs (`<MEDIA_DIR>/subagent_out`)."""
  return _media_dir() / "subagent_out"

def input_staging_root() -> Path:
  """Root directory for staged sub-agent **inputs**.

  This must be a path that the sub-agent process can read. Set
  ``SUBAGENT_INPUT_STAGING_DIR`` to a host directory shared with the
  sub-agent — e.g. ``/storage/subagent_in`` for the docker-compose contract,
  or any other path co-located with the sub-agent process.

  When the env var is unset, fall back to ``<project_root>/data/subagent_in``,
  which is writable for native (non-docker) deployments and avoids assuming
  ``/storage`` exists with the right permissions on the host.
  """
  raw = subagent_input_staging_dir_env()
  if raw:
    return Path(raw).expanduser().resolve()
  return (_project_root() / "data" / "subagent_in").resolve()

@dataclass(frozen=True)
class StagedFile:
  path: str  # absolute, real path inside MEDIA_DIR
  name: str  # original basename
  size_bytes: int
  mime: str  # best-effort MIME type, may be ``application/octet-stream``
  kind: str  # one of: image, video, audio, document
  thumbnail_base64: str | None = None  # JPEG thumbnail for WhatsApp document preview

@dataclass(frozen=True)
class SkippedFile:
  source_path: str
  name: str
  reason: str  # human-readable, embedded in [SUBTASK FINISHED]

@dataclass(frozen=True)
class StagedOutputs:
  staged: list[StagedFile]
  skipped: list[SkippedFile]

_EXT_MIME_OVERRIDES = {
  # ``mimetypes`` doesn't ship a webp mapping on every Python build.
  ".webp": "image/webp",
  # ZIP-based Office formats — ``mimetypes`` only has these on some platforms.
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".rtf": "application/rtf",
  ".7z": "application/x-7z-compressed",
  ".rar": "application/vnd.rar",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".m4a": "audio/mp4",
  ".opus": "audio/ogg",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".avif": "image/avif",
}

def _sniff_mime_from_bytes(head: bytes) -> str | None:
  """Best-effort magic-byte sniffing for files whose extension lies (or is missing).

  Covers the formats most likely to come out of a sub-agent: PDFs, common
  image/video/audio containers, and ZIP-based Office documents. Returns
  ``None`` for anything we can't classify confidently — callers should keep
  using extension-based fallbacks in that case.

  Detection order matters: more specific signatures come first so e.g. a
  WebP is not misidentified as RIFF.
  """
  if not head:
    return None

  if head.startswith(b'%PDF-'):
    return 'application/pdf'
  if head.startswith(b'\x89PNG\r\n\x1a\n'):
    return 'image/png'
  if head.startswith(b'\xff\xd8\xff'):
    return 'image/jpeg'
  if head.startswith(b'GIF87a') or head.startswith(b'GIF89a'):
    return 'image/gif'
  if head[:4] == b'RIFF' and head[8:12] == b'WEBP':
    return 'image/webp'
  if head[:4] == b'RIFF' and head[8:12] == b'WAVE':
    return 'audio/wav'
  if head[:4] == b'RIFF' and head[8:12] == b'AVI ':
    return 'video/x-msvideo'
  if head[:4] == b'OggS':
    return 'audio/ogg'
  if head.startswith(b'fLaC'):
    return 'audio/flac'
  if head.startswith(b'ID3') or (len(head) >= 2 and head[0] == 0xFF and (head[1] & 0xE0) == 0xE0):
    return 'audio/mpeg'
  if len(head) >= 12 and head[4:8] == b'ftyp':
    brand = head[8:12]
    # ``mp42`` is a generic ISO Base Media v2 brand used by both video and
    # audio containers. We default to video here because audio-only files
    # almost always carry an ``M4A `` / ``M4B `` brand instead. The
    # downstream WhatsApp behaviour for either kind is the same — the
    # important thing is that the kind is *not* ``document``, so the file
    # opens with a media player rather than as a broken PDF.
    if brand in (b'isom', b'iso2', b'mp41', b'mp42', b'avc1', b'dash'):
      return 'video/mp4'
    if brand in (b'M4A ', b'M4B '):
      return 'audio/mp4'
    if brand in (b'qt  ',):
      return 'video/quicktime'
    return 'video/mp4'
  if head.startswith(b'\x1aE\xdf\xa3'):
    return 'video/x-matroska'
  # ZIP / Office Open XML / OpenDocument / EPUB — all start with PK\x03\x04.
  if head.startswith(b'PK\x03\x04') or head.startswith(b'PK\x05\x06') or head.startswith(b'PK\x07\x08'):
    return 'application/zip'
  if head.startswith(b'\x1f\x8b'):
    return 'application/gzip'
  if head.startswith(b'7z\xbc\xaf\x27\x1c'):
    return 'application/x-7z-compressed'
  if head.startswith(b'Rar!\x1a\x07'):
    return 'application/vnd.rar'
  if head.startswith(b'BM'):
    return 'image/bmp'
  if head.startswith(b'{\\rtf'):
    return 'application/rtf'
  if head[:4] == b'<!DO' or head[:5].lower() == b'<html':
    return 'text/html'
  return None

def _read_head(path: str, n: int = 16) -> bytes:
  try:
    with open(path, 'rb') as fh:
      return fh.read(n)
  except OSError:
    return b''

def _is_animated_webp(path_str: str) -> bool:
  """Check if a WebP file is animated by inspecting the VP8X chunk."""
  try:
    with open(path_str, 'rb') as f:
      header = f.read(21)
      if len(header) < 21:
        return False
      if header[:4] != b'RIFF' or header[8:12] != b'WEBP':
        return False
      if header[12:16] == b'VP8X':
        return bool(header[20] & 0x02)
      return False
  except OSError:
    return False

_WA_SUPPORTED_IMAGE_MIMES = {"image/jpeg", "image/png", "image/webp"}
_WA_SUPPORTED_VIDEO_MIMES = {"video/mp4"}
_WA_SUPPORTED_AUDIO_MIMES = {"audio/mpeg", "audio/mp4", "audio/ogg"}

def detect_kind(path: str | os.PathLike[str]) -> tuple[str, str]:
  """Return ``(kind, mime)`` for the given file path.

  ``kind`` is one of ``image``, ``video``, ``audio``, ``document``. It maps to
  the WhatsApp/Baileys media kind expected by ``src/wa/outbound.js``.

  Detection strategy:
    1. Map known extensions via ``_EXT_MIME_OVERRIDES`` and ``mimetypes``.
    2. If the extension yields no usable mime (missing ext or
       ``application/octet-stream``), sniff the file's first 16 bytes via
       :func:`_sniff_mime_from_bytes`. This catches sub-agent outputs whose
       filename has no extension or a misleading one — without sniffing,
       WhatsApp clients fall back to rendering them as PDF, which corrupts
       the user-visible attachment.
    3. Final fallback is ``application/octet-stream`` + ``document``.

  Stickers are intentionally not auto-detected — proper WhatsApp stickers
  require custom EXIF metadata that sub-agents won't produce. A bare ``.webp``
  is sent as an ``image`` instead.
  """
  path_str = str(path)
  ext = os.path.splitext(path_str)[1].lower()
  mime = _EXT_MIME_OVERRIDES.get(ext)
  if mime is None:
    guessed, _ = mimetypes.guess_type(path_str)
    mime = guessed

  needs_sniff = (not mime) or mime == 'application/octet-stream' or not ext
  if needs_sniff and os.path.isfile(path_str):
    sniffed = _sniff_mime_from_bytes(_read_head(path_str, 16))
    if sniffed:
      mime = sniffed

  if not mime:
    mime = 'application/octet-stream'

  if mime.startswith("image/"):
    if mime in _WA_SUPPORTED_IMAGE_MIMES:
      if mime == "image/webp" and os.path.isfile(path_str) and _is_animated_webp(path_str):
        return "document", mime
      return "image", mime
    return "document", mime
  if mime.startswith("video/"):
    if mime in _WA_SUPPORTED_VIDEO_MIMES:
      return "video", mime
    return "document", mime
  if mime.startswith("audio/"):
    if mime in _WA_SUPPORTED_AUDIO_MIMES:
      return "audio", mime
    return "document", mime
  return "document", mime

def _format_size(size_bytes: int) -> str:
  if size_bytes < 1024:
    return f"{size_bytes} B"
  if size_bytes < 1024 * 1024:
    return f"{size_bytes / 1024:.1f} KB"
  return f"{size_bytes / (1024 * 1024):.1f} MB"

def stage_output_files(
  session_id: str,
  raw_paths: Iterable[str],
  *,
  files_content: list[dict] | None = None,
  base_dir: Path | None = None,
) -> StagedOutputs:
  """Copy ``raw_paths`` into ``<base_dir>/<session_id>/`` and validate them.

  Files that are missing, not regular files, or larger than
  ``MAX_FILE_SIZE_BYTES`` are reported as ``SkippedFile`` instead of being
  copied. Copy errors are also captured as skips so a single bad file does
  not abort the rest of the batch.

  ``files_content`` is an optional list of ``{name, content_base64, mime}``
  dicts. When provided and non-empty, files are written from base64 data
  instead of being copied from ``raw_paths`` (cross-machine mode). When
  absent or empty, the original path-copy behavior runs (backward-compat).

  ``base_dir`` defaults to :func:`staging_root` and is overridable for tests.
  """
  staged: list[StagedFile] = []
  skipped: list[SkippedFile] = []

  if not session_id:
    logger.warning("stage_output_files called with empty session_id; nothing staged")
    return StagedOutputs(staged=[], skipped=[])

  paths = [str(p) for p in raw_paths if isinstance(p, (str, os.PathLike))]
  if not files_content and not paths:
    return StagedOutputs(staged=[], skipped=[])

  target_root = (base_dir or staging_root()) / session_id
  try:
    target_root.mkdir(parents=True, exist_ok=True)
  except OSError as err:
    logger.exception(
      "stage_output_files: failed to create staging dir %s: %s",
      target_root, err,
    )
    for src in paths:
      skipped.append(SkippedFile(
        source_path=src,
        name=os.path.basename(src),
        reason=f"staging dir unavailable: {err}",
      ))
    return StagedOutputs(staged=[], skipped=skipped)

  if files_content:
    # Cross-machine: write files from base64 content
    used_names: set[str] = set()
    for item in files_content:
      name = (item.get("name") or "unnamed").strip()
      b64 = item.get("content_base64") or ""
      if not b64:
        skipped.append(SkippedFile(source_path="", name=name, reason="empty base64 content"))
        continue
      # Pre-check: estimated decoded size avoids materializing a huge
      # allocation when the payload is clearly oversized.
      estimated_size = len(b64) * 3 // 4
      if estimated_size > MAX_FILE_SIZE_BYTES:
        skipped.append(SkippedFile(
          source_path="", name=name,
          reason=f"file too large (estimated {_format_size(estimated_size)} > 200 MB)",
        ))
        continue
      try:
        data = base64.b64decode(b64)
      except Exception as err:
        skipped.append(SkippedFile(source_path="", name=name, reason=f"base64 decode failed: {err}"))
        continue

      size = len(data)
      if size > MAX_FILE_SIZE_BYTES:
        skipped.append(SkippedFile(source_path="", name=name, reason=f"file too large ({_format_size(size)} > 200 MB)"))
        continue

      final_name = name
      counter = 1
      while final_name in used_names or (target_root / final_name).exists():
        stem, ext = os.path.splitext(name)
        final_name = f"{stem}_{counter}{ext}"
        counter += 1
      used_names.add(final_name)

      dest = target_root / final_name
      try:
        dest.write_bytes(data)
      except OSError as err:
        skipped.append(SkippedFile(source_path="", name=name, reason=f"write failed: {err}"))
        continue

      real_dest = str(dest.resolve())
      kind, mime_detected = detect_kind(real_dest)
      # Use provided mime as fallback only if detection gives octet-stream
      provided_mime = item.get("mime") or ""
      if mime_detected == "application/octet-stream" and provided_mime:
        mime_detected = provided_mime
        # Re-check kind with provided mime
        if mime_detected.startswith("image/"):
          kind = "image" if mime_detected in _WA_SUPPORTED_IMAGE_MIMES else "document"
        elif mime_detected.startswith("video/"):
          kind = "video" if mime_detected in _WA_SUPPORTED_VIDEO_MIMES else "document"
        elif mime_detected.startswith("audio/"):
          kind = "audio" if mime_detected in _WA_SUPPORTED_AUDIO_MIMES else "document"

      thumbnail_b64_val: str | None = None
      if kind == "document" and generate_document_thumbnail is not None:
        try:
          thumb_bytes = generate_document_thumbnail(real_dest, mime_detected)
          if thumb_bytes:
            thumbnail_b64_val = base64.b64encode(thumb_bytes).decode("ascii")
        except Exception:
          logger.debug("stage_output_files: thumbnail generation failed for %s", real_dest, exc_info=True)

      staged.append(StagedFile(
        path=real_dest,
        name=final_name,
        size_bytes=size,
        mime=mime_detected,
        kind=kind,
        thumbnail_base64=thumbnail_b64_val,
      ))

    # Second pass: copy any raw_paths whose basename is NOT already represented
    # in files_content. These are oversized files that SubAgents couldn't inline;
    # they still live on disk (single-machine or shared-FS) and must not be
    # silently dropped when files_content is non-empty.
    content_original_names = {(item.get("name") or "unnamed").strip() for item in files_content}
    for src in paths:
      name = os.path.basename(src) or "unnamed"
      if name in content_original_names:
        # Already delivered via base64 content; skip the path-copy.
        continue
      if not src or not os.path.exists(src):
        logger.warning(
          "stage_output_files: oversized raw_path not found, skipping: %s", src,
        )
        skipped.append(SkippedFile(source_path=src, name=name, reason="file not found"))
        continue
      if not os.path.isfile(src):
        skipped.append(SkippedFile(source_path=src, name=name, reason="not a regular file"))
        continue
      try:
        size = os.path.getsize(src)
      except OSError as err:
        skipped.append(SkippedFile(source_path=src, name=name, reason=f"stat failed: {err}"))
        continue
      if size > MAX_FILE_SIZE_BYTES:
        skipped.append(SkippedFile(
          source_path=src,
          name=name,
          reason=f"file too large ({_format_size(size)} > 200 MB)",
        ))
        continue

      final_name = name
      counter = 1
      while final_name in used_names or (target_root / final_name).exists():
        stem, ext = os.path.splitext(name)
        final_name = f"{stem}_{counter}{ext}"
        counter += 1
      used_names.add(final_name)

      dest = target_root / final_name
      try:
        shutil.copyfile(src, dest)
      except OSError as err:
        skipped.append(SkippedFile(source_path=src, name=name, reason=f"copy failed: {err}"))
        continue

      real_dest = str(dest.resolve())
      kind, mime = detect_kind(real_dest)

      thumbnail_b64_val = None
      if kind == "document" and generate_document_thumbnail is not None:
        try:
          thumb_bytes = generate_document_thumbnail(real_dest, mime)
          if thumb_bytes:
            thumbnail_b64_val = base64.b64encode(thumb_bytes).decode("ascii")
        except Exception:
          logger.debug("stage_output_files: thumbnail generation failed for %s", real_dest, exc_info=True)

      staged.append(StagedFile(
        path=real_dest,
        name=final_name,
        size_bytes=size,
        mime=mime,
        kind=kind,
        thumbnail_base64=thumbnail_b64_val,
      ))

    return StagedOutputs(staged=staged, skipped=skipped)

  # Original path-copy logic (single-machine / backward-compat)
  used_names = set()
  for src in paths:
    name = os.path.basename(src) or "unnamed"
    if not src or not os.path.exists(src):
      skipped.append(SkippedFile(source_path=src, name=name, reason="file not found"))
      continue
    if not os.path.isfile(src):
      skipped.append(SkippedFile(source_path=src, name=name, reason="not a regular file"))
      continue
    try:
      size = os.path.getsize(src)
    except OSError as err:
      skipped.append(SkippedFile(source_path=src, name=name, reason=f"stat failed: {err}"))
      continue
    if size > MAX_FILE_SIZE_BYTES:
      skipped.append(SkippedFile(
        source_path=src,
        name=name,
        reason=f"file too large ({_format_size(size)} > 200 MB)",
      ))
      continue

    # Avoid clobbering when two source files share a basename.
    final_name = name
    counter = 1
    while final_name in used_names or (target_root / final_name).exists():
      stem, ext = os.path.splitext(name)
      final_name = f"{stem}_{counter}{ext}"
      counter += 1
    used_names.add(final_name)

    dest = target_root / final_name
    try:
      shutil.copyfile(src, dest)
    except OSError as err:
      skipped.append(SkippedFile(source_path=src, name=name, reason=f"copy failed: {err}"))
      continue

    real_dest = str(dest.resolve())
    kind, mime = detect_kind(real_dest)
    # NOTE: MP4 re-encoding (ffmpeg -preset fast) was removed to avoid
    # blocking the bot for 10-20s during subagent result delivery. Videos
    # from common sources (yt-dlp, TikTok) are typically already
    # WhatsApp-compatible (H.264+AAC+faststart).

    # Generate a JPEG thumbnail for documents. WhatsApp shows a preview
    # bubble for documents only when ``jpegThumbnail`` is provided; without
    # it the preview is solid white.  We skip thumbnail generation for
    # audio/video because WhatsApp already renders those natively.
    thumbnail_b64: str | None = None
    if kind == "document" and generate_document_thumbnail is not None:
      try:
        thumb_bytes = generate_document_thumbnail(real_dest, mime)
        if thumb_bytes:
          thumbnail_b64 = base64.b64encode(thumb_bytes).decode("ascii")
      except Exception:
        logger.debug(
          "stage_output_files: thumbnail generation failed for %s",
          real_dest, exc_info=True,
        )

    staged.append(StagedFile(
      path=real_dest,
      name=final_name,
      size_bytes=size,
      mime=mime,
      kind=kind,
      thumbnail_base64=thumbnail_b64,
    ))

  return StagedOutputs(staged=staged, skipped=skipped)

def stage_input_files(
  session_id: str,
  raw_paths: Iterable[str],
  *,
  base_dir: Path | None = None,
) -> list[str]:
  """Copy ``raw_paths`` into ``<base_dir>/<session_id>/`` for the sub-agent.

  Returns the list of staged absolute paths in input order, omitting files
  that are missing / unreadable / oversized. Used to bridge the filesystem
  gap between the bridge process and a containerised sub-agent: the staged
  paths must live under a directory both sides have mounted (configured via
  ``SUBAGENT_INPUT_STAGING_DIR``; see :func:`input_staging_root`).
  """
  if not session_id:
    logger.warning("stage_input_files called with empty session_id; nothing staged")
    return []

  paths = [str(p) for p in raw_paths if isinstance(p, (str, os.PathLike))]
  if not paths:
    return []

  target_root = (base_dir or input_staging_root()) / session_id
  try:
    target_root.mkdir(parents=True, exist_ok=True)
  except OSError as err:
    logger.exception(
      "stage_input_files: failed to create staging dir %s: %s",
      target_root, err,
    )
    return []

  staged_paths: list[str] = []
  used_names: set[str] = set()
  for src in paths:
    name = os.path.basename(src) or "unnamed"
    if not src or not os.path.exists(src):
      logger.warning("stage_input_files: source missing, skipping: %s", src)
      continue
    if not os.path.isfile(src):
      logger.warning("stage_input_files: not a regular file, skipping: %s", src)
      continue
    try:
      size = os.path.getsize(src)
    except OSError as err:
      logger.warning("stage_input_files: stat failed for %s: %s", src, err)
      continue
    if size > MAX_FILE_SIZE_BYTES:
      logger.warning(
        "stage_input_files: %s is too large (%s); skipping",
        src, _format_size(size),
      )
      continue

    final_name = name
    counter = 1
    while final_name in used_names or (target_root / final_name).exists():
      stem, ext = os.path.splitext(name)
      final_name = f"{stem}_{counter}{ext}"
      counter += 1
    used_names.add(final_name)

    dest = target_root / final_name
    try:
      shutil.copyfile(src, dest)
    except OSError as err:
      logger.warning("stage_input_files: copy failed for %s: %s", src, err)
      continue
    staged_paths.append(str(dest.resolve()))

  return staged_paths

def cleanup_input_staging(session_id: str, *, base_dir: Path | None = None) -> None:
  """Remove ``<base_dir>/<session_id>/`` after the sub-agent finishes.

  Errors are logged and swallowed — leaking a staging dir is far less
  bad than crashing the post-task cleanup path.
  """
  if not session_id:
    return
  target_root = (base_dir or input_staging_root()) / session_id
  if not target_root.exists():
    return
  try:
    shutil.rmtree(target_root)
  except OSError as err:
    logger.warning(
      "cleanup_input_staging: failed to remove %s: %s",
      target_root, err,
    )

def format_file_list(staged: list[StagedFile], skipped: list[SkippedFile]) -> str:
  """Render staged + skipped files for embedding into ``[SUBTASK FINISHED]``.

  Returns an empty string when there is nothing to mention.
  """
  if not staged and not skipped:
    return ""
  lines: list[str] = []
  if staged:
    lines.append(f"Output files attached ({len(staged)}):")
    for f in staged:
      lines.append(f"- {f.name} ({f.kind}, {_format_size(f.size_bytes)})")
  if skipped:
    if lines:
      lines.append("")
    lines.append(f"Files skipped ({len(skipped)}):")
    for s in skipped:
      lines.append(f"- {s.name}: {s.reason}")
  return "\n".join(lines)
