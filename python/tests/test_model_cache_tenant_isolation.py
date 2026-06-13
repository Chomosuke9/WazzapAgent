"""Regression tests for per-tenant isolation of the LLM2 model caches.

Two bot accounts (tenants) can be present in the SAME WhatsApp group (same
``chat_id`` JID), and each tenant has its own ``<folder_path>/db`` database.
Before the fix, ``_llm2_model_cache`` was keyed by the bare ``chat_id`` and
``_default_llm2_model_cache`` was a single process-global scalar, so one
tenant's cached model selection leaked into (and was returned for) another
tenant. These tests pin the corrected tenant-scoped behaviour.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import bridge.db.core as core  # noqa: E402
from bridge.db.core import tenant_db_context, close_all_connections  # noqa: E402
from bridge.db.models_repository import (  # noqa: E402
    add_model,
    get_default_llm2_model,
    get_llm2_model,
    set_llm2_model,
)


def _reset_caches() -> None:
    with core._cache_lock:
        core._llm2_model_cache.clear()
    core._default_llm2_model_cache.clear()
    close_all_connections()


def test_per_chat_model_cache_isolated_between_tenants(tmp_path):
    """Same chat_id, two tenants -> independent per-chat model selections."""
    _reset_caches()
    tenant_a = str(tmp_path / "tenant-a")
    tenant_b = str(tmp_path / "tenant-b")
    shared_chat = "group@g.us"

    with tenant_db_context(tenant_a):
        set_llm2_model(shared_chat, "model-A")
    with tenant_db_context(tenant_b):
        set_llm2_model(shared_chat, "model-B")

    # The cached read for tenant A must NOT be poisoned by tenant B's write.
    with tenant_db_context(tenant_a):
        assert get_llm2_model(shared_chat) == "model-A"
    with tenant_db_context(tenant_b):
        assert get_llm2_model(shared_chat) == "model-B"

    _reset_caches()


def test_default_model_cache_isolated_between_tenants(tmp_path):
    """Each tenant resolves its OWN default model, not the first one cached."""
    _reset_caches()
    tenant_a = str(tmp_path / "tenant-a")
    tenant_b = str(tmp_path / "tenant-b")

    with tenant_db_context(tenant_a):
        add_model("model-A", "Model A")  # only active model -> default
    with tenant_db_context(tenant_b):
        add_model("model-B", "Model B")

    with tenant_db_context(tenant_a):
        default_a = get_default_llm2_model()
    with tenant_db_context(tenant_b):
        default_b = get_default_llm2_model()

    assert default_a is not None and default_a["model_id"] == "model-A"
    assert default_b is not None and default_b["model_id"] == "model-B"

    _reset_caches()
