"""``bridge.media`` — media + sticker concerns.

Consolidates two cohesive media concerns into one package:

* ``visual`` — visual-attachment processing for the LLM pipeline
  (``build_visual_parts`` / ``redact_multimodal_content`` / the media-enable +
  size-limit config helpers). This is the former top-level ``bridge/media.py``.
* ``resolver`` — media / sticker *resolution* helpers moved off the top of
  ``bridge/session.py`` in Step 08. They operate on a caller-supplied
  ``media_paths_by_chat`` dict so the per-account mutable state stays owned by
  the :class:`~bridge.session.AgentSession` instance.

Public symbols are re-exported here so existing imports
(``from ..media import build_visual_parts``) keep working unchanged.
"""
from __future__ import annotations

from .visual import (
  build_visual_parts,
  llm1_media_enabled,
  llm2_media_enabled,
  media_max_bytes,
  media_max_items,
  redact_multimodal_content,
)
from .resolver import (
  _append_sticker_log_to_history,
  _cleanup_stale_media_paths,
  _guess_mime_from_path,
  _parse_sticker_args,
  _resolve_quoted_media_attachments,
  _resolve_sticker_media,
  _store_media_path,
  materialize_visual_media,
  materialize_media_for_subagent,
  materialize_quoted_media,
)
__all__ = [
  # visual
  "build_visual_parts",
  "llm1_media_enabled",
  "llm2_media_enabled",
  "media_max_bytes",
  "media_max_items",
  "redact_multimodal_content",
  # resolver
  "_append_sticker_log_to_history",
  "_cleanup_stale_media_paths",
  "_guess_mime_from_path",
  "_parse_sticker_args",
  "_resolve_quoted_media_attachments",
  "_resolve_sticker_media",
  "_store_media_path",
  "materialize_visual_media",
  "materialize_media_for_subagent",
  "materialize_quoted_media",
]
