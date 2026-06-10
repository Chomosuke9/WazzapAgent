# Step 33 — Multi-account entrypoint (Python) + per-tenant DB paths — Verification Report

## (1) Verdict: PARTIAL

The step's explicit deliverables (accounts loader, multi-account `main()`,
per-tenant DB **path** resolution, removal of Node's global single socket) are
all implemented correctly and match the spec. However, the multi-account boot
delivered here still routes through **module-global mutable state** that is NOT
tenant-keyed — most notably the dashboard stats buffer — which produces a
real cross-tenant leak that contradicts the step's own "no cross-talk"
acceptance language. The narrowly-specified checks (settings.db isolation,
`getSock` zero, `test_accounts.py`) pass; the broader isolation guarantee does
not fully hold.

## (2) Acceptance-criteria checklist

| Criterion | Result | Notes |
|---|---|---|
| `accounts.py` exists; `load_accounts() -> list[AccountConfig]`; `AccountConfig={folder_path,node_url}` | PASS | `migration/python/bridge/accounts.py`. Frozen dataclass, correct fields. |
| Single-account fallback preserved when no list configured | PASS | `load_accounts()` falls back to `FOLDER_PATH`/`DATA_DIR`/repo `data`, shared `NODE_URL`; always returns ≥1. |
| `accounts.py` contains no socket/agent logic | PASS | Pure config parsing; imports only `log`. |
| `main()` loops `load_accounts()`, builds `make_wa_socket+AgentSession` per account, `gather`s `connect()` concurrently, runs to shutdown | PASS | `main.py` builds one session per account, awaits `asyncio.gather(*(session.run(node_url, stop_event)))`; SIGINT/SIGTERM → shared `stop_event`. |
| `db.py` resolves DBs under `<folder_path>/db/` (per-tenant), single-account default kept | PASS | `ContextVar _tenant_db_dir` + `current_tenant_db_root()`; settings/stats/moderation resolvers prefer tenant root, else legacy env/`DATA_DIR`. Connections cached by `(db_kind, str(path))` so tenants get independent handles on the shared event-loop thread. `sticker_db.py` also resolves under `current_tenant_db_root()`. |
| Each `AgentSession` uses its account's DB handles | PASS | `AgentSession.run()` binds `set_tenant_db_dir(self.folder_path)` before `connect()`, so the pump task + handlers inherit the context; reset on exit. ContextVar propagates correctly across `gather` (each coroutine is a Task with its own context copy). |
| `pytest test_accounts.py`: returns configured list; fallback works | PASS (static) | `tests/test_accounts.py` covers fallback, `FOLDER_PATHS`, JSON list/object, per-account `node_url` override, missing-file raise. Not executed per instructions. |
| `git grep -n "getSock" migration/node/` → zero matches | PASS | Zero matches. Node account state is per-`AccountContext`/registry (comments confirm singletons removed). |
| Two-account boot: A handled by A's session → writes A/db, B→B/db, no cross-talk | PARTIAL | settings/moderation/stickers DB **writes** are correctly isolated via ContextVar. Dashboard **stats** are NOT (see Issue 1). |
| `pytest migration/python/tests/` and `node --test` green | NOT VERIFIED | Not run per read-only/no-suite constraints. |

## (3) Issues

- [MAJOR] migration/python/bridge/dashboard.py:35-44,128-141 — `_stats_buffer` and
  `_user_stats_buffer` are **module-global** dicts keyed by `(chat_id, period,...)`
  with no tenant/`folder_path` component, and `start_flush_loop()` is invoked once
  **per session** (`session.run` → N flush-loop tasks). `flush_to_db()` drains the
  entire shared buffer and writes via `upsert_stats_batch`, whose path is resolved
  from the **calling task's** ContextVar. Whichever tenant's flush loop fires first
  drains stats for ALL tenants into that one tenant's `stats.db`. Result: tenant B's
  stats land in tenant A's `db/stats.db` (cross-tenant leak + racy data loss),
  directly contradicting the acceptance line "a message to account A … writes to
  A/db/ … likewise for B, with no cross-talk." (settings.db — the criterion's
  explicit verification target — is unaffected.) Likely belongs to Step 32 state
  isolation but manifests under Step 33's multi-account boot.

- [MINOR] migration/python/bridge/db.py:113-118 (and the cache dicts
  `_prompt_cache`/`_permission_cache`/`_mode_cache`/`_triggers_cache`/
  `_subagent_enabled_cache`/`_llm2_model_cache`/`_mute_cache`) — these in-memory
  caches are module-global keyed by `chat_id` only, not by tenant. If two tenants
  are both present in the **same** WhatsApp group (same group JID == same
  `chat_id`), tenant B's read returns tenant A's cached value instead of B's own
  DB row. Persistent reads/writes are correctly per-tenant (ContextVar), so this is
  a cache-layer leak limited to the shared-chat_id case and self-heals on the
  per-chat invalidate events; still an isolation gap for the multi-account goal.

- [MINOR] spec reference vs. code — the spec lists `subagent.db` among the
  per-tenant DBs to route, but no `subagent.db` exists in the codebase
  (`SubTaskTracker` is an in-memory per-session object; grep for `subagent.db`
  returns nothing). Not a defect — there is simply no sub-agent DB to route — but
  the spec/README mention is unmet by design.

## (4) Must-NOT-do / contract / isolation notes

- "Do not change the wire protocol" — UPHELD. No protocol/frame changes in this step.
- "Do not share one DB file across accounts" — UPHELD for settings/stats/moderation/
  stickers **files** (per-tenant `<folder_path>/db/*.db` via ContextVar; connections
  keyed by resolved path). The leak in Issue 1 is at the in-memory **buffer** layer,
  not a shared DB file.
- "Do not update docs here" — UPHELD.
- Teardown: `session.run()` finally flushes/checkpoints/closes DBs, clears the
  webhook queue handler, disconnects the socket, cancels tracked tasks, and resets
  the ContextVar token. `db_close_all_connections()`/`checkpoint_all_dbs()` iterate
  the shared (single-thread) path-keyed store; being called from each session's
  finally + atexit is redundant but harmless at shutdown (store empties). Per-account
  sub-agent webhook port collision is resolved via `base_port + index` (index 0 keeps
  the configured port, preserving single-account behaviour).
- ContextVar propagation across `asyncio.gather` is correct: each gathered coroutine
  becomes a Task carrying its own context copy, so per-session `set_tenant_db_dir`
  does not bleed between sessions, and child tasks (pump/flush/bg) inherit it.
