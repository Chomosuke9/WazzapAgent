"""Sticker catalog scanning and resolution.

Scans ``data/stickers/`` at startup for image files AND resolves user-added
stickers from the database (via ``sticker_db``).  Provides:
- A catalog text for injection into the LLM system prompt.
- A resolver to map sticker names (without extension) to file paths.

Per-chat override logic
-----------------------
If a chat has **any** user-added stickers in the DB, those stickers are used
exclusively — the filesystem default catalog is hidden from both the catalog
text and the resolver.  This lets admins fully customise the bot's sticker
set without the default stickers bleeding through.

If a chat has **no** user stickers at all, the filesystem catalog (``data/stickers/``)
is used as the fallback so the bot still has stickers to express itself.

``resolve_sticker`` / ``sticker_catalog_text`` / ``sticker_names`` all accept an
optional *chat_id*.  Without it the functions fall back to filesystem-only
behaviour (backwards-compatible with existing call-sites).
"""
from __future__ import annotations

from pathlib import Path

from .log import setup_logging
from .sticker_db import get_sticker as _db_get_sticker
from .sticker_db import list_stickers as _db_list_stickers

try:
  from .db import current_tenant_db_root as _current_tenant_db_root
except ImportError:  # pragma: no cover - import path fallback
  from bridge.db import current_tenant_db_root as _current_tenant_db_root  # type: ignore

logger = setup_logging()

STICKER_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "stickers"
STICKER_EXTENSIONS = {".webp", ".png", ".jpg", ".jpeg", ".gif"}

# Per-tenant filesystem catalog cache (CONTRACT.md §8). Keyed by the RESOLVED
# sticker directory (str) → { name_without_ext(lowered): absolute_path }. Each
# tenant's ``<folder_path>/stickers`` is scanned independently so one account's
# file stickers never leak into another's catalog. The key fully determines the
# value, so this is a tenant-keyed cache (the sanctioned pattern used by the
# in-memory caches in ``db/core.py``), NOT shared mutable tenant state. When no
# tenant is bound (single-account / tests) the legacy module-level ``STICKER_DIR``
# is used as the key, so single-account behaviour is unchanged.
_catalogs: dict[str, dict[str, str]] = {}


def _current_sticker_dir() -> Path:
  """Resolve the active tenant's filesystem sticker directory.

  When an :class:`~bridge.session.AgentSession` has bound a tenant, resolve
  ``<folder_path>/stickers`` (CONTRACT.md §8 — sibling of the tenant's ``db``
  root). Otherwise fall back to the legacy module-level ``STICKER_DIR``
  (single-account / tests — unchanged)."""
  root = _current_tenant_db_root()
  if root is not None:
    return root.parent / "stickers"
  return STICKER_DIR


def _scan_dir(sticker_dir: Path) -> dict[str, str]:
  """Scan a single sticker directory and return its name→path catalog.

  Scanning rules (extensions, lowercased stem keys, sorted iteration) are
  identical to the previous module-global ``_scan`` — only the target
  directory is now tenant-resolved."""
  catalog: dict[str, str] = {}

  if not sticker_dir.is_dir():
    sticker_dir.mkdir(parents=True, exist_ok=True)
    logger.info("sticker directory created: %s", sticker_dir)
    return catalog

  for f in sorted(sticker_dir.iterdir()):
    if not f.is_file():
      continue
    if f.suffix.lower() not in STICKER_EXTENSIONS:
      continue
    name = f.stem.lower()
    catalog[name] = str(f)

  if catalog:
    logger.info("loaded %d sticker(s) from %s: %s", len(catalog), sticker_dir, list(catalog.keys()))
  else:
    logger.info("no stickers found in %s", sticker_dir)
  return catalog


def _current_catalog() -> dict[str, str]:
  """Return the active tenant's filesystem catalog, scanning + caching once
  per resolved sticker directory."""
  sticker_dir = _current_sticker_dir()
  key = str(sticker_dir)
  catalog = _catalogs.get(key)
  if catalog is None:
    catalog = _scan_dir(sticker_dir)
    _catalogs[key] = catalog
  return catalog


def _chat_has_user_stickers(chat_id: str) -> bool:
  """Return True if the chat has at least one user-added sticker in the DB."""
  try:
    return len(_db_list_stickers(chat_id)) > 0
  except Exception as exc:
    logger.warning("_chat_has_user_stickers: DB lookup failed chat_id=%s: %s", chat_id, exc)
    return False


def sticker_catalog_text(chat_id: str | None = None) -> str:
  """Return formatted sticker list for system prompt injection.

  - If *chat_id* is provided and the chat has user-added stickers → show ONLY
    those stickers (default filesystem catalog is suppressed).
  - If *chat_id* is provided but the chat has no user stickers → show the
    default filesystem catalog as fallback.
  - If *chat_id* is None → filesystem catalog only (backwards-compatible).
  """
  catalog = _current_catalog()

  if chat_id:
    try:
      db_names = _db_list_stickers(chat_id)
    except Exception as exc:
      logger.warning("sticker_catalog_text: DB lookup failed: %s", exc)
      db_names = []

    if db_names:
      # Chat has user stickers — show only those, hide defaults
      return "\n".join(f"- {name}" for name in sorted(db_names))

  # No user stickers (or no chat_id) → fall back to filesystem defaults
  if not catalog:
    return "(no stickers available)"
  return "\n".join(f"- {name}" for name in sorted(catalog.keys()))


def resolve_sticker(name: str, chat_id: str | None = None) -> dict | None:
  """Find sticker by name (case-insensitive).

  Returns a dict ``{"file_path": str|None, "lottie_payload": str|None}``
  or ``None`` if not found.

  Callers should check ``lottie_payload`` first:
  - If set → use ``send_lottie_sticker_payload`` to relay with full animation.
  - Otherwise → use ``send_sticker`` with ``file_path``.

  Lookup order when *chat_id* is provided:
    1. If the chat has ANY user stickers → search DB only (no filesystem fallback).
    2. If the chat has NO user stickers  → search filesystem catalog only.

  When *chat_id* is None → filesystem catalog only (backwards-compatible).
  """
  normalized = name.strip().lower()

  if chat_id:
    if _chat_has_user_stickers(chat_id):
      # Chat has its own sticker set — only resolve from DB (returns dict or None)
      try:
        return _db_get_sticker(chat_id, normalized)
      except Exception as exc:
        logger.warning("resolve_sticker: DB lookup failed name=%s: %s", normalized, exc)
      return None
    # No user stickers for this chat → fall through to filesystem

  # Filesystem catalog (default) — wrap as dict for uniform interface
  path = _current_catalog().get(normalized)
  if path:
    return {"file_path": path, "lottie_payload": None}
  return None


def sticker_names(chat_id: str | None = None) -> list[str]:
  """Return sorted list of available sticker names visible for a chat.

  Follows the same override logic as ``sticker_catalog_text``.
  """
  catalog = _current_catalog()

  if chat_id:
    try:
      db_names = _db_list_stickers(chat_id)
    except Exception as exc:
      logger.warning("sticker_names: DB lookup failed: %s", exc)
      db_names = []

    if db_names:
      return sorted(db_names)

  return sorted(catalog.keys())
