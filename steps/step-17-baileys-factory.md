# Step 17 — `baileysFactory.ts`

## Context
Generalize the single global-`sock` `startWhatsApp` into a per-`folderPath`
factory that creates or resumes a Baileys socket, builds its `AccountContext`,
ensures the tenant folder layout exists, and registers everything in the account
registry. This is what lets one Node process drive N WhatsApp accounts.

## Contract references
- **CONTRACT.md §5** — `BaileysFactoryOptions`, `AccountEntry`, `WaStatus`.
- **CONTRACT.md §8** — the factory **creates** `auth/`, `db/`, `media/`,
  `stickers/` under `folderPath` and resolves the tenant's DB paths under
  `<folderPath>/db/` (Node is responsible per §8).

## Files to read before starting
- `src/wa/connection.ts` (`startWhatsApp`, the global `sock`/`getSock`)
- `src/account/accountContext.ts` (Step 16)
- `src/server/accountRegistry.ts` (Step 15)
- `src/config.ts` (current global `authDir`/db paths)
- `src/utils/cachedAuthState.js` (auth-state provider)
- `src/db.ts` (Step 08 — to parameterize DB paths per tenant)

## Files to create
### `src/account/baileysFactory.ts`
**Purpose:** `createOrResumeAccount(opts: BaileysFactoryOptions): Promise<AccountEntry>`.
**Exports:** `createOrResumeAccount`.
**Must NOT contain:** the WS server (Step 20), action dispatch (Step 19), event
forwarding wiring beyond attaching listeners that call into Step 18's forwarder.
**Key logic:**
- `ensureFolderLayout(folderPath)` creates `auth/`, `db/`, `media/`, `stickers/`
  (CONTRACT.md §8) before use.
- auth dir = `<folderPath>/auth` (replaces the global `config.authDir`).
- Build the `AccountContext` (Step 16) and a per-tenant DB handle pointing at
  `<folderPath>/db/*.db` (CONTRACT.md §8).
- `makeWASocket`, wire `creds.update`, `connection.update` (normalize to
  `WaStatus` and update `entry.waStatus` + notify), `groups.update`,
  `group-participants.update`, and the two `messages.upsert` listeners — all
  bound to this account's context (no module global).
- Idempotent: if `registry.get(folderPath)?.sock` is live, return it.

## Files to modify
### `src/wa/connection.ts`
**Change:** Reduce to shared, account-parameterized helpers (QR print,
`handleButtonResponse`, `parseModelReply`, model form helpers). Keep a thin
`getSock()` shim that returns the **first/default** account's sock so the still
live old boot path (`index.ts`) keeps working until Step 28.
**Location:** `startWhatsApp` (extracted to the factory), the `let sock` global.

### `src/db.ts`
**Change:** Allow opening DBs under a caller-supplied tenant `db/` directory
(add a path-injecting init alongside the existing global one). Do **not** remove
the global path init yet (old boot still uses it).
**Location:** the `init`/path-constant area.

## Files to delete
None (the global `sock` is shimmed, not deleted, until Step 28/30).

## Acceptance criteria
- `pnpm typecheck` passes with zero errors.
- `tests/node/baileys-factory.test.ts` (mock Baileys): creating accounts for two
  distinct folder paths produces two registry entries with two distinct
  `AccountContext`s and two distinct auth dirs; calling again for the same folder
  returns the same entry (idempotent).
- A run against a temp folder confirms `auth/ db/ media/ stickers/` are created.
- `pnpm dev` (old boot path) still pairs and round-trips one account.
- `node --test` green.

## Must NOT do
- Do not start the WS server or change `index.ts` boot (Step 20/28).
- Do not delete the global `getSock()` shim yet.
- Do not move per-tenant DB wiring into Python here (Step 33).

## Depends on
Step 15, Step 16.
