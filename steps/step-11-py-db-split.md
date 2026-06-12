# Step 11 — Split `bridge/db.py` into per-domain repositories
**Phase:** 3 · **Risk:** med · **Depends on:** step-10

## Goal
Break the 1,722-line `db.py` into per-domain repository modules over a shared
core, mirroring the Node `db/` layout, while **keeping** the proven per-tenant
ContextVar routing and tenant-keyed caches.

## Why (audit — Medium #5; "healthiest big file")
`db.py` mixes ~6 domains (settings/models/activation/stats/mutes). It is already
tenant-safe (the audit confirmed clean ContextVar routing + namespaced caches),
so this is a **navigability/cohesion** split, not a correctness fix. Do not
disturb the routing that already works.

## Changes
- New `bridge/db/` package:
  - `core.py` — connection getters, `_db_resilient` decorator, the per-tenant
    ContextVar routing, schema/migrations (moved verbatim).
  - `settings_repository.py`, `models_repository.py`,
    `moderation_repository.py`, `stats_repository.py`,
    `activation_repository.py` — the domain functions/classes.
- Preserve the public import surface used across the bridge (re-export from
  `bridge/db/__init__.py`) so callers need minimal churn; or update callers if
  cleaner. Keep behavior identical.

## OOP / target
Domain-cohesive repository modules sharing one core; per-tenant routing
unchanged. Optionally expose repository classes for symmetry with Node, but do
not break the working ContextVar model to do so.

## Must NOT
- Must NOT change SQL, schema, caching, or the per-tenant routing behavior.
- Must NOT introduce cross-tenant leakage.

## Verification
- Python gates green (`pytest python/tests` no new failures, incl.
  `test_db_resilience`, `test_dashboard_isolation`, `test_invalidate_chat_caches`
  beyond their known env-baseline state).

## Done when
- `db.py` is split into `bridge/db/`; behavior identical; gates green.
