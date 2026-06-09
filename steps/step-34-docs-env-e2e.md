# Step 34 — Docs, env, and end-to-end

## Context
Final step: document the reversed topology and multi-account model, add/clarify
the relevant env/config keys, deprecate the old client endpoint, and add a
two-account end-to-end smoke test so a fresh clone can boot both stacks.

## Contract references
- **CONTRACT.md §1** (protocol/handshake), **§4** (`make_wa_socket` usage),
  **§8** (folder layout) — the docs must describe these as written; docs must
  not contradict CONTRACT.md.

## Files to read before starting
- `AGENTS.md`, `README.md`, `.env.example`
- `MIGRATION_PLAN.md` (topology diagrams), `CONTRACT.md`
- `src/config.ts` (final config keys), `python/bridge/accounts.py` (Step 33)

## Files to create
### `tests/e2e/two-account.md` (or a scripted test under `tests/`)
**Purpose:** Reproducible two-account end-to-end smoke procedure/script.
**Key logic:** boot Node server + two `WaSocket`/`AgentSession` pairs against two
`folder_path`s; assert each pairs/resumes independently and a message to each is
handled without cross-talk.

## Files to modify
### `README.md`
**Change:** Replace the "Node client → Python server" description and Quick Start
with the reversed topology: Node serves on `WS_LISTEN_PORT`; Python `WaSocket`
clients connect via `node_url`; per-tenant folder layout (CONTRACT.md §8);
`make_wa_socket` usage example.
**Location:** Architecture, Quick Start, protocol sections.

### `AGENTS.md`
**Change:** Update the architecture-at-a-glance, the WebSocket protocol section,
directory structure (add `src/server/`, `src/account/`, `src/protocol/`,
`python/wasocket/`), and the env-var table.
**Location:** the relevant sections.

### `.env.example`
**Change:** Add `WS_LISTEN_PORT` (Node server) and `NODE_URL`/accounts config
keys (Python clients). Mark `LLM_WS_ENDPOINT` **deprecated** (the direction
reversed; it is no longer dialed by Node).
**Location:** WS/transport keys.

## Files to delete
None.

## Acceptance criteria
- `grep -n "WS_LISTEN_PORT\|node_url\|NODE_URL" README.md AGENTS.md .env.example`
  shows the new keys documented.
- `grep -n "deprecated" .env.example` flags `LLM_WS_ENDPOINT`.
- The two-account e2e (`tests/e2e/two-account`) passes: two accounts boot,
  pair/resume, and handle messages independently.
- A fresh-clone walkthrough following the README boots the Node server and at
  least one `WaSocket` client without error.
- No doc statement contradicts CONTRACT.md §1/§4/§8 (manual review checklist in
  the PR description).

## Must NOT do
- Do not change runtime behavior or the wire protocol in this step.
- Do not introduce config keys not used by the code.
- Do not remove `LLM_WS_ENDPOINT` from `.env.example` (deprecate, keep for
  backward-compat reference).

## Depends on
Step 33.
