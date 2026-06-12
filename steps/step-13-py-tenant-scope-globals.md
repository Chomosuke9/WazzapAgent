# Step 13 — Tenant-scope remaining process-globals
**Phase:** 4 · **Risk:** med · **Depends on:** step-12

## Goal
Eliminate the last pieces of cross-tenant shared state so multi-account mode is
fully isolated, and fix the multi-account sub-agent callback URL.

## Why (audit — Medium #9, #4)
- `stickers.py:_catalog` (line 36, `_scan` 40) is a process-global filesystem
  sticker catalog scanned once from a module-level `STICKER_DIR` — NOT
  tenant-scoped (while DB user-stickers are). Latent cross-tenant bug.
- `history.py:_cached_names` (line 13) is a process-global assistant name — all
  tenants share one identity.
- `main.py build_session` hardcodes a localhost `SUBAGENT_WEBHOOK_URL`,
  overriding the configured value and breaking cross-machine sub-agent deploys.
  (The webhook **port** offset itself is already correct.)

## Changes
- Make the sticker catalog tenant-scoped: own it on the `AgentSession` (or a
  per-tenant `StickerCatalog` built from the tenant's `stickers/` dir) instead
  of a module global.
- Make the assistant name per-tenant (resolve from the session's config, not a
  module-level cache).
- Fix `main.py` so a configured `SUBAGENT_WEBHOOK_URL` is honored per account
  (compose host from config + the per-account port offset), only falling back to
  localhost when unset.

## OOP / target
No tenant-relevant state at module scope; sticker catalog and identity are
owned by the session/tenant.

## Must NOT
- Must NOT change single-account behavior or the existing port-offset logic.
- Must NOT change sticker file formats or scanning rules.

## Verification
- Python gates green; `test_multi_account`, `test_dashboard_isolation` pass.
- A focused test: two sessions with different `stickers/` dirs and assistant
  names see their own catalog/identity (bounded waits, teardown).

## Done when
- Sticker catalog + assistant name are per-tenant; webhook URL honored in
  multi-account; gates green.
