# Step 30 — Delete Node `wsClient.ts`

## Context
After the flip (Step 28) Node is a WS server; the WS **client** (`wsClient.ts`)
and the temporary `getSock()` shim from Step 17 are dead. Remove them and the
now-unused client config so the codebase has a single transport.

## Contract references
- None changed. The client's `computeReconnectDelay` logic already lives in
  Python `wasocket/transport.py` (Step 26); its tests moved there.

## Files to read before starting
- Original - `migration/node/wsClient.ts`
- `git grep -n "wsClient" migration/node/` (find all residual imports)
- `migration/node/wa/connection.ts` (the `getSock()` shim from Step 17)
- `migration/node/config.ts` (`wsEndpoint`/`wsToken` client fields)

## Files to create
None.

## Files to modify
### `migration/node/wa/connection.ts`
**Change:** Remove the leftover global-`sock`/`getSock()` shim now that all
sockets live in the registry (Step 17). Update any remaining importer to read
from the registry/`AccountEntry`.
**Location:** the `let sock`/`getSock` shim.

### `migration/node/config.ts`
**Change:** Remove `wsEndpoint` (client dial URL) now that Node only serves.
Keep `wsListenPort` and `wsToken` (token now guards the server). Keep
`wsReconnect*`/`wsHeartbeat*` only if still referenced; otherwise remove.
**Location:** the `config` object.

## Files to delete
- `migration/node/wsClient.ts` — unused after the flip.
- Any `tests/node/*wsclient*` test whose intent moved to Python `test_transport.py`
  (remove or port the assertion; do not leave a dangling import).

## Acceptance criteria
- `git grep -n "wsClient" migration/node/` returns **zero** matches.
- `pnpm typecheck` passes with zero errors (no dangling imports).
- `pnpm dev` boots the server normally.
- `node --test 'tests/node/**/*.test.mjs'` green (no test references the deleted
  client).

## Must NOT do
- Do not touch the Python `wasocket/transport.py` (the ported logic stays).
- Do not remove `wsListenPort`/`wsToken`.
- Do not change server behavior.

## Depends on
Step 28.
