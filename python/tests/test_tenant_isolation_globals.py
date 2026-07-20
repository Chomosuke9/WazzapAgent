"""Step 13 — remaining process-globals are now tenant-scoped.

Proves the three isolation fixes (audit Medium #9, #4) with NO sockets and NO
hanging async — pure synchronous resolution inside each session's tenant scope:

  1. The FILESYSTEM sticker catalog is per-tenant: two sessions with different
     ``<folder_path>/stickers`` dirs each see ONLY their own file stickers (the
     former module-global ``_catalog`` leaked one tenant's stickers to all).
  2. The assistant NAME/identity is per-tenant: two sessions with different
     assistant names resolve their OWN name / aliases / mention-pattern (the
     former module-global ``_cached_names`` shared one identity across tenants).
  3. ``SUBAGENT_WEBHOOK_URL`` is HONORED in multi-account: a configured remote
     host is preserved while the per-account port offset is applied; only an
     unset value falls back to localhost.

NO-HANG DISCIPLINE: temp dirs only; sessions are CONSTRUCTED (never connected);
no event loop; no DB calls (filesystem-only catalog path is exercised).
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

_TESTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(_TESTS_DIR.parent))  # python

from bridge.session import AgentSession  # noqa: E402
from bridge.stickers import resolve_sticker, sticker_catalog_text, sticker_names  # noqa: E402
from bridge.history import (  # noqa: E402
    assistant_aliases,
    assistant_name,
    assistant_name_pattern,
)
from bridge.main import _resolve_webhook_url  # noqa: E402
from bridge.subagent.config import SUBAGENT_WEBHOOK_PORT  # noqa: E402
from wasocket import make_wa_socket  # noqa: E402


def _session(folder: str, name: str) -> AgentSession:
    # Construct only (do NOT connect) — we exercise catalog + identity resolution.
    return AgentSession(make_wa_socket(folder), assistant_name=name)


def _write_sticker(folder: Path, stem: str) -> Path:
    sticker_dir = folder / "stickers"
    sticker_dir.mkdir(parents=True, exist_ok=True)
    f = sticker_dir / f"{stem}.webp"
    f.write_bytes(b"RIFF0000WEBP")  # content irrelevant; only the name is cataloged
    return f


def test_sticker_catalog_is_per_tenant(tmp_path):
    folder_a = tmp_path / "tenantA"
    folder_b = tmp_path / "tenantB"
    a_file = _write_sticker(folder_a, "happy_a")
    b_file = _write_sticker(folder_b, "sad_b")

    sess_a = _session(str(folder_a), "Aria")
    sess_b = _session(str(folder_b), "Zeta")

    # --- As tenant A: only A's filesystem sticker is visible. ---
    with sess_a.tenant_db():
        assert sticker_names() == ["happy_a"]
        assert "happy_a" in sticker_catalog_text()
        assert "sad_b" not in sticker_catalog_text()
        assert resolve_sticker("happy_a") == {"file_path": str(a_file), "lottie_payload": None}
        assert resolve_sticker("sad_b") is None  # B's sticker MUST NOT leak in

    # --- As tenant B: only B's filesystem sticker is visible. ---
    with sess_b.tenant_db():
        assert sticker_names() == ["sad_b"]
        assert "sad_b" in sticker_catalog_text()
        assert "happy_a" not in sticker_catalog_text()
        assert resolve_sticker("sad_b") == {"file_path": str(b_file), "lottie_payload": None}
        assert resolve_sticker("happy_a") is None  # A's sticker MUST NOT leak in


def test_assistant_identity_is_per_tenant(tmp_path):
    folder_a = tmp_path / "tenantA"
    folder_b = tmp_path / "tenantB"

    sess_a = _session(str(folder_a), "Aria")
    sess_b = _session(str(folder_b), "Zeta")

    with sess_a.tenant_db():
        assert assistant_name() == "Aria"
        assert assistant_aliases() == ["aria"]
        assert assistant_name_pattern().search("hey Aria there")
        assert not assistant_name_pattern().search("hey Zeta there")

    with sess_b.tenant_db():
        assert assistant_name() == "Zeta"
        assert assistant_aliases() == ["zeta"]
        assert assistant_name_pattern().search("hey Zeta there")
        assert not assistant_name_pattern().search("hey Aria there")


def test_assistant_identity_multi_alias_per_tenant(tmp_path):
    sess = _session(str(tmp_path / "tenantC"), "Bot, Robot")
    with sess.tenant_db():
        assert assistant_name() == "Bot"  # primary = first
        assert assistant_aliases() == ["bot", "robot"]
        assert assistant_name_pattern().search("ping Robot")


def test_webhook_url_preserves_configured_remote_port():
    base = SUBAGENT_WEBHOOK_PORT
    # An explicit public/proxy port must never be rewritten to a local bind
    # port. Multi-account expansion is opt-in via placeholders.
    with patch.dict(
        "os.environ",
        {"SUBAGENT_WEBHOOK_URL": "https://callbacks.example.com:9999/subagent/callback"},
        clear=False,
    ):
        url0 = _resolve_webhook_url(base + 0)
        url1 = _resolve_webhook_url(base + 1)
    assert url0 == "https://callbacks.example.com:9999/subagent/callback"
    assert url1 == "https://callbacks.example.com:9999/subagent/callback"


def test_webhook_url_expands_explicit_multi_account_placeholders():
    base = SUBAGENT_WEBHOOK_PORT
    with patch.dict(
        "os.environ",
        {"SUBAGENT_WEBHOOK_URL": "https://callbacks.example.com:{port}/cb/{index}"},
        clear=False,
    ):
        url = _resolve_webhook_url(base + 2, index=2)
    assert url == f"https://callbacks.example.com:{base + 2}/cb/2"


def test_loopback_callback_keeps_legacy_multi_account_port_offset():
    base = SUBAGENT_WEBHOOK_PORT
    with patch.dict(
        "os.environ",
        {"SUBAGENT_WEBHOOK_URL": "http://localhost:8081/subagent/callback"},
        clear=False,
    ):
        url0 = _resolve_webhook_url(base, index=0)
        url1 = _resolve_webhook_url(base + 1, index=1)
    assert url0 == "http://localhost:8081/subagent/callback"
    assert url1 == f"http://localhost:{base + 1}/subagent/callback"


def test_webhook_url_falls_back_to_localhost_when_unset():
    base = SUBAGENT_WEBHOOK_PORT
    env = {k: v for k, v in __import__("os").environ.items() if k != "SUBAGENT_WEBHOOK_URL"}
    with patch.dict("os.environ", env, clear=True):
        url = _resolve_webhook_url(base + 2)
    assert url == f"http://localhost:{base + 2}/subagent/callback"
