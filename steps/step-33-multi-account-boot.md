# Step 33 — Multi-account entrypoint (Python) + per-tenant DB paths

## Context
With state isolated (Step 32), the bridge can drive N accounts: read an accounts
config, create one `WaSocket` + `AgentSession` per `folder_path`, and connect
them all to the one Node `node_url`. This step also wires each account's DB
connections to its **per-tenant** `db/` directory (CONTRACT.md §8) on both sides
and confirms Node has no global single-socket left.

## Contract references
- **CONTRACT.md §4** — `make_wa_socket(folder_path)` + `connect(node_url)` per
  account.
- **CONTRACT.md §8** — each account's DBs resolve under `<folder_path>/db/`
  (supersedes the old global `SETTINGS_DB_PATH` etc.).

## Files to read before starting
- `python/bridge/main.py` `main()` (Step 32 form)
- `python/bridge/db.py` (current global DB-path resolution from env)
- `python/bridge/session.py` (Step 32)
- `src/server/wsServer.ts`, `src/account/baileysFactory.ts` (confirm Node already
  creates per-folder accounts on connect, Steps 17/20)

## Files to create
### `python/bridge/accounts.py` (config loader)
**Purpose:** Read the accounts config (env list or `accounts.json`) into a list
of `folder_path`s + the shared `node_url`.
**Exports:** `load_accounts() -> list[AccountConfig]` where
`AccountConfig = { folder_path: str, node_url: str }`.
**Must NOT contain:** socket or agent logic.
**Key logic:** support a single-account fallback (one `folder_path` from env) so
Step 32's single-account behavior is preserved when no list is configured.

## Files to modify
### `python/bridge/main.py`
**Change:** `main()` loops over `load_accounts()`, creating
`make_wa_socket(folder_path)` + `AgentSession(sock)` per account and
`await`ing all `connect(node_url)`s concurrently; run until shutdown.
**Location:** `main()`.

### `python/bridge/db.py`
**Change:** Make DB-path resolution **per-tenant**: open `settings.db`/`stats.db`/
`moderation.db`/`subagent.db`/`stickers.db` under a supplied
`<folder_path>/db/` directory (CONTRACT.md §8) instead of the global env paths.
Each `AgentSession` uses its account's DB handles. Keep a single-account default
for backward compatibility during rollout.
**Location:** the connection-open / path-constant functions.

### `src/wa/connection.ts` / `src/account/*`
**Change:** Verify `getSock()` and any global single-socket assumption are gone
(removed in Step 30); accounts exist only via the registry/`baileysFactory`.
**Location:** confirm-only; fix any residual reference.

## Files to delete
None.

## Acceptance criteria
- `pytest python/tests/test_accounts.py`: `load_accounts()` returns the configured
  list; single-account fallback works when no list is set.
- Two-account boot (staging or stub server): start the bridge with two
  `folder_path`s → both `WaSocket`s reach `ready`; a message to account A is
  handled by A's session and writes to `A/db/`, and likewise for B, with **no**
  cross-talk (verified by checking each tenant's `settings.db` row counts).
- `git grep -n "getSock" src/` returns zero matches (Node fully multi-account).
- `pytest python/tests/` and `node --test 'tests/node/**/*.test.mjs'` green.

## Must NOT do
- Do not change the wire protocol.
- Do not share one DB file across accounts (per-tenant `db/` is the contract).
- Do not update docs here (Step 34).

## Depends on
Step 30, Step 32.
