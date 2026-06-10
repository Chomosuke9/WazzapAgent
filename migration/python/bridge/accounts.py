"""accounts.py — multi-account config loader (Step 33).

Reads the bridge's account configuration into a flat list of
:class:`AccountConfig` records, each pairing a tenant ``folder_path`` (CONTRACT
§8 — the per-account ``<folder_path>/{auth,db,media,stickers}`` root) with the
shared Node ``node_url`` (CONTRACT §4 — every account dials the SAME Node WS
server; the tenant is announced in the ``hello`` handshake).

Configuration sources (first match wins):

1. ``ACCOUNTS_JSON`` / ``ACCOUNTS_CONFIG`` — path to a JSON file. The file is
   either a list of objects ``[{"folder_path": "...", "node_url": "..."}, ...]``
   or an object ``{"accounts": [...], "node_url": "..."}``. A per-account
   ``node_url`` overrides the shared default; otherwise the shared ``NODE_URL``
   is used.
2. ``FOLDER_PATHS`` — comma-separated list of tenant folders, all sharing the
   single ``NODE_URL``.
3. Single-account fallback — one ``folder_path`` from ``FOLDER_PATH`` /
   ``DATA_DIR`` (or the repo's default ``migration/data`` dir), with
   ``NODE_URL``. This preserves the Step 32 single-account boot behaviour when
   no multi-account list is configured.

This module is intentionally logic-free beyond config parsing: it contains NO
socket, DB, or agent logic (those live in ``wasocket`` / ``session`` / ``db``).
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

from .log import setup_logging

logger = setup_logging()

DEFAULT_NODE_URL = "ws://localhost:3000"


@dataclass(frozen=True)
class AccountConfig:
  """One tenant: its ``folder_path`` (account key + ``<folder_path>/db`` root)
  and the Node WS ``node_url`` it should dial."""

  folder_path: str
  node_url: str


def _default_folder_path() -> str:
  """Single-account default tenant key — mirrors the Node default account key
  (``config.dataDir`` == ``migration/data``)."""
  return str(Path(__file__).resolve().parent.parent.parent / "data")


def _shared_node_url() -> str:
  raw = os.getenv("NODE_URL")
  if raw and raw.strip():
    return raw.strip()
  return DEFAULT_NODE_URL


def _accounts_json_path() -> Optional[Path]:
  raw = os.getenv("ACCOUNTS_JSON") or os.getenv("ACCOUNTS_CONFIG")
  if raw and raw.strip():
    return Path(raw.strip())
  return None


def _from_json(path: Path, shared_node_url: str) -> List[AccountConfig]:
  data = json.loads(path.read_text(encoding="utf-8"))
  if isinstance(data, dict):
    file_node_url = data.get("node_url") or shared_node_url
    raw_accounts = data.get("accounts", [])
  elif isinstance(data, list):
    file_node_url = shared_node_url
    raw_accounts = data
  else:
    raise ValueError(
      f"accounts config {path} must be a list or an object with an 'accounts' key"
    )

  accounts: List[AccountConfig] = []
  for item in raw_accounts:
    if isinstance(item, str):
      folder_path = item
      node_url = file_node_url
    elif isinstance(item, dict):
      folder_path = item.get("folder_path") or item.get("folderPath")
      node_url = item.get("node_url") or item.get("nodeUrl") or file_node_url
    else:
      raise ValueError(f"invalid account entry in {path}: {item!r}")
    if not folder_path or not str(folder_path).strip():
      raise ValueError(f"account entry missing folder_path in {path}: {item!r}")
    accounts.append(
      AccountConfig(folder_path=str(folder_path).strip(), node_url=str(node_url).strip())
    )
  return accounts


def _from_folder_paths(raw: str, shared_node_url: str) -> List[AccountConfig]:
  folders = [p.strip() for p in raw.split(",") if p.strip()]
  return [AccountConfig(folder_path=f, node_url=shared_node_url) for f in folders]


def load_accounts() -> List[AccountConfig]:
  """Return the configured accounts (CONTRACT §4 / §8).

  Always returns at least one :class:`AccountConfig` — the single-account
  fallback is used when no multi-account list is configured, preserving the
  Step 32 single-account boot.
  """
  shared_node_url = _shared_node_url()

  json_path = _accounts_json_path()
  if json_path is not None:
    if not json_path.exists():
      raise FileNotFoundError(f"accounts config not found: {json_path}")
    accounts = _from_json(json_path, shared_node_url)
    if accounts:
      logger.info("Loaded %d account(s) from %s", len(accounts), json_path)
      return accounts
    logger.warning("accounts config %s was empty; using single-account fallback", json_path)

  folder_paths = os.getenv("FOLDER_PATHS")
  if folder_paths and folder_paths.strip():
    accounts = _from_folder_paths(folder_paths, shared_node_url)
    if accounts:
      logger.info("Loaded %d account(s) from FOLDER_PATHS", len(accounts))
      return accounts

  # Single-account fallback (Step 32 behaviour preserved).
  folder_path = os.getenv("FOLDER_PATH") or os.getenv("DATA_DIR") or _default_folder_path()
  logger.info(
    "No multi-account list configured; single-account fallback folder_path=%s", folder_path
  )
  return [AccountConfig(folder_path=str(folder_path).strip(), node_url=shared_node_url)]
