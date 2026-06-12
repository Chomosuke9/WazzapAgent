"""Tests for bridge.accounts.load_accounts() (Step 33).

Covers:
  * single-account fallback when no multi-account list is configured (preserves
    Step 32 behaviour),
  * ``FOLDER_PATHS`` comma-separated list sharing one ``NODE_URL``,
  * ``ACCOUNTS_JSON`` file (list form and object form, with per-account
    ``node_url`` override).

These are pure config-parsing tests — no sockets, no DB, no event loop — so
they import only ``bridge.accounts`` (which pulls only ``bridge.log``).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bridge.accounts import AccountConfig, DEFAULT_NODE_URL, load_accounts  # noqa: E402

_ACCOUNT_ENV_KEYS = (
  "ACCOUNTS_JSON",
  "ACCOUNTS_CONFIG",
  "FOLDER_PATHS",
  "FOLDER_PATH",
  "DATA_DIR",
  "NODE_URL",
)


@pytest.fixture(autouse=True)
def _clear_account_env(monkeypatch):
  """Start every test from a clean account-config environment."""
  for key in _ACCOUNT_ENV_KEYS:
    monkeypatch.delenv(key, raising=False)
  yield


def test_single_account_fallback_uses_defaults():
  accounts = load_accounts()
  assert len(accounts) == 1
  assert isinstance(accounts[0], AccountConfig)
  # Default folder_path is the repo's data dir; node_url is the default.
  assert accounts[0].folder_path.endswith("data")
  assert accounts[0].node_url == DEFAULT_NODE_URL


def test_single_account_fallback_honours_folder_path_and_node_url(monkeypatch):
  monkeypatch.setenv("FOLDER_PATH", "/tenants/solo")
  monkeypatch.setenv("NODE_URL", "ws://node.example:9000")
  accounts = load_accounts()
  assert accounts == [AccountConfig(folder_path="/tenants/solo", node_url="ws://node.example:9000")]


def test_folder_paths_comma_separated_share_node_url(monkeypatch):
  monkeypatch.setenv("FOLDER_PATHS", "/tenants/a, /tenants/b ,/tenants/c")
  monkeypatch.setenv("NODE_URL", "ws://shared:3000")
  accounts = load_accounts()
  assert [a.folder_path for a in accounts] == ["/tenants/a", "/tenants/b", "/tenants/c"]
  assert all(a.node_url == "ws://shared:3000" for a in accounts)


def test_accounts_json_list_form(tmp_path, monkeypatch):
  cfg = tmp_path / "accounts.json"
  cfg.write_text(
    json.dumps([{"folder_path": "/t/a"}, {"folder_path": "/t/b", "node_url": "ws://b:3000"}]),
    encoding="utf-8",
  )
  monkeypatch.setenv("ACCOUNTS_JSON", str(cfg))
  monkeypatch.setenv("NODE_URL", "ws://default:3000")
  accounts = load_accounts()
  assert accounts == [
    AccountConfig(folder_path="/t/a", node_url="ws://default:3000"),
    AccountConfig(folder_path="/t/b", node_url="ws://b:3000"),
  ]


def test_accounts_json_object_form_with_shared_node_url(tmp_path, monkeypatch):
  cfg = tmp_path / "accounts.json"
  cfg.write_text(
    json.dumps({"node_url": "ws://obj:3000", "accounts": ["/t/x", {"folder_path": "/t/y"}]}),
    encoding="utf-8",
  )
  monkeypatch.setenv("ACCOUNTS_CONFIG", str(cfg))
  accounts = load_accounts()
  assert accounts == [
    AccountConfig(folder_path="/t/x", node_url="ws://obj:3000"),
    AccountConfig(folder_path="/t/y", node_url="ws://obj:3000"),
  ]


def test_missing_accounts_json_raises(tmp_path, monkeypatch):
  monkeypatch.setenv("ACCOUNTS_JSON", str(tmp_path / "nope.json"))
  with pytest.raises(FileNotFoundError):
    load_accounts()


def test_returns_at_least_one_account_even_when_everything_unset():
  # The fallback guarantees a non-empty list so main()'s gather always has work.
  assert len(load_accounts()) >= 1
