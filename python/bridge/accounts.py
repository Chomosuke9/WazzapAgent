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
2. Marker-gated ``./accounts.json`` — written atomically by the control panel
   and polled by :class:`bridge.account_supervisor.AccountSupervisor`.
3. ``FOLDER_PATHS`` — comma-separated list of tenant folders, all sharing the
   single ``NODE_URL``.
4. Single-account fallback — one ``folder_path`` from ``FOLDER_PATH`` /
   ``DATA_DIR`` (or the repo's default ``data`` dir), with
   ``NODE_URL``. This preserves the Step 32 single-account boot behaviour when
   no multi-account list is configured.

An optional integer ``slot`` pins the account's callback/direct-invoke port
offset. This module contains no socket, DB, or agent lifecycle logic.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

from .log import setup_logging
from . import config

logger = setup_logging()

DEFAULT_NODE_URL = "ws://localhost:3000"
MANAGED_ACCOUNTS_MARKER = "wazzapagents-control-panel"


@dataclass(frozen=True)
class AccountConfig:
  """One tenant: its ``folder_path`` (account key + ``<folder_path>/db`` root)
  and the Node WS ``node_url`` it should dial."""

  folder_path: str
  node_url: str
  # Stable per-account offset for callback/direct-invoke ports. Managed
  # catalogs persist this so deleting account A never reroutes account B's
  # outstanding callbacks to a different tenant after a restart.
  slot: int | None = None


def _project_root() -> Path:
  return Path(__file__).resolve().parent.parent.parent


def _default_folder_path() -> str:
  """Single-account default tenant key — mirrors the Node default account key
  (``config.dataDir`` == ``data``)."""
  return str(_project_root() / "data")


def _default_managed_accounts_path() -> Path:
  return _project_root() / "accounts.json"


def _shared_node_url() -> str:
  raw = config.node_url_env()
  if raw and raw.strip():
    return raw.strip()
  return DEFAULT_NODE_URL


def _accounts_json_path() -> Optional[Path]:
  raw = config.accounts_json_env()
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
      slot = item.get("slot")
    else:
      raise ValueError(f"invalid account entry in {path}: {item!r}")
    if isinstance(item, str):
      slot = None
    if not folder_path or not str(folder_path).strip():
      raise ValueError(f"account entry missing folder_path in {path}: {item!r}")
    if slot is not None and (isinstance(slot, bool) or not isinstance(slot, int) or not 0 <= slot <= 999):
      raise ValueError(f"invalid account slot in {path}: {slot!r}")
    accounts.append(
      AccountConfig(
        folder_path=str(folder_path).strip(),
        node_url=str(node_url).strip(),
        slot=slot,
      )
    )
  return accounts


def _from_folder_paths(raw: str, shared_node_url: str) -> List[AccountConfig]:
  folders = [p.strip() for p in raw.split(",") if p.strip()]
  return [AccountConfig(folder_path=f, node_url=shared_node_url) for f in folders]


def _is_managed_accounts_file(path: Path) -> bool:
  try:
    data = json.loads(path.read_text(encoding="utf-8"))
  except (OSError, ValueError):
    return False
  return isinstance(data, dict) and data.get("managed_by") == MANAGED_ACCOUNTS_MARKER


def _normalize_accounts(accounts: List[AccountConfig]) -> List[AccountConfig]:
  """Canonicalize tenant keys and reject path/slot collisions early."""
  normalized: List[AccountConfig] = []
  seen_paths: set[str] = set()
  seen_slots: set[int] = set()
  for account in accounts:
    folder_path = str(Path(account.folder_path).expanduser().resolve())
    path_key = folder_path.casefold() if os.name == "nt" else folder_path
    if path_key in seen_paths:
      raise ValueError(f"duplicate account folder_path: {account.folder_path!r}")
    seen_paths.add(path_key)
    if account.slot is not None:
      if account.slot in seen_slots:
        raise ValueError(f"duplicate account slot: {account.slot}")
      seen_slots.add(account.slot)
    config.validate_node_url(account.node_url)
    normalized.append(AccountConfig(folder_path, account.node_url, account.slot))
  return normalized


def load_accounts(*, log: bool = True) -> List[AccountConfig]:
  """Return the configured accounts (CONTRACT §4 / §8).

  Always returns at least one :class:`AccountConfig` — the single-account
  fallback is used when no multi-account list is configured, preserving the
  Step 32 single-account boot.
  """
  shared_node_url = _shared_node_url()
  config.validate_node_url(shared_node_url)

  json_path = _accounts_json_path()
  if json_path is not None:
    if not json_path.exists():
      raise FileNotFoundError(f"accounts config not found: {json_path}")
    accounts = _from_json(json_path, shared_node_url)
    if accounts:
      if log:
        logger.info("Loaded %d account(s) from %s", len(accounts), json_path)
      return _normalize_accounts(accounts)
    if log:
      logger.warning("accounts config %s was empty; using single-account fallback", json_path)

  # The control panel owns this marker-gated default file. Checking it before
  # FOLDER_PATHS lets add/remove operations take effect while the bridge keeps
  # running, without mutating process environment variables.
  managed_path = _default_managed_accounts_path()
  if managed_path.exists() and _is_managed_accounts_file(managed_path):
    accounts = _from_json(managed_path, shared_node_url)
    if accounts:
      if log:
        logger.info("Loaded %d account(s) from managed catalog %s", len(accounts), managed_path)
      return _normalize_accounts(accounts)

  folder_paths = config.folder_paths_env()
  if folder_paths and folder_paths.strip():
    accounts = _from_folder_paths(folder_paths, shared_node_url)
    if accounts:
      if log:
        logger.info("Loaded %d account(s) from FOLDER_PATHS", len(accounts))
      return _normalize_accounts(accounts)

  # Single-account fallback (Step 32 behaviour preserved).
  folder_path = config.folder_path_env() or _default_folder_path()
  if log:
    logger.info(
      "No multi-account list configured; single-account fallback folder_path=%s", folder_path
    )
  return _normalize_accounts([
    AccountConfig(folder_path=str(folder_path).strip(), node_url=shared_node_url)
  ])
