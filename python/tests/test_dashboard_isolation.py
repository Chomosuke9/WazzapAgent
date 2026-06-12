"""Regression: per-tenant stats.db isolation via per-session DashboardStats.

Before the fix the dashboard stats buffer was a single module-global shared
across all AgentSessions, so one tenant's buffered stats could be flushed into
another tenant's stats.db (and N per-session flush loops drained one shared
buffer). Now each AgentSession owns its own DashboardStats instance and flushes
under its own tenant DB context, so stats land only in the owning tenant's
``<folder_path>/db/stats.db`` (CONTRACT.md §8).

NO-HANG DISCIPLINE: pure synchronous DB ops; no sockets connect; temp dirs only.
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bridge.session import AgentSession  # noqa: E402
from bridge.dashboard import _period_keys  # noqa: E402
from bridge.db import get_stats  # noqa: E402
from wasocket import make_wa_socket  # noqa: E402


def _session(folder: str) -> AgentSession:
    # Construct only (do NOT connect) — we exercise the buffer + DB layer.
    return AgentSession(make_wa_socket(folder))


def test_stats_db_isolation_no_cross_tenant_flush():
    with tempfile.TemporaryDirectory(prefix="dash_iso_") as tmp:
        tmp_path = Path(tmp)
        folder_a = str(tmp_path / "tenantA")
        folder_b = str(tmp_path / "tenantB")
        chat_a = "groupA@g.us"
        chat_b = "groupB@g.us"

        sess_a = _session(folder_a)
        sess_b = _session(folder_b)

        # Accumulate on BOTH sessions BEFORE flushing. With a shared module-global
        # buffer (the bug) these would mingle and a single flush would drain both
        # into one tenant's DB; with per-session buffers they stay separate.
        sess_a._dashboard.record_stat(chat_a, "messages_processed", 3)
        sess_b._dashboard.record_stat(chat_b, "messages_processed", 7)

        # Flush each under its OWN tenant DB context.
        with sess_a.tenant_db():
            sess_a._dashboard.flush_to_db()
        with sess_b.tenant_db():
            sess_b._dashboard.flush_to_db()

        period_type, period_key = _period_keys()[0]  # daily

        with sess_a.tenant_db():
            a_self = get_stats(chat_a, period_type, period_key) or {}
            a_cross = get_stats(chat_b, period_type, period_key) or {}
        with sess_b.tenant_db():
            b_self = get_stats(chat_b, period_type, period_key) or {}
            b_cross = get_stats(chat_a, period_type, period_key) or {}

        assert a_self.get("messages_processed") == 3, a_self
        assert b_self.get("messages_processed") == 7, b_self
        # No cross-talk: each tenant's stats.db must NOT contain the other's chat.
        assert not a_cross.get("messages_processed"), a_cross
        assert not b_cross.get("messages_processed"), b_cross
