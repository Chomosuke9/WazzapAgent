# Step 16 — `AccountContext` + per-account state isolation (D2)

## Context
Today `caches.ts` exposes module-global `Map`/`Set`s keyed by `chatId` only, and
`identifiers.ts` reads them directly. With multiple accounts these collide
(same `chatId` in two accounts; shared contextMsgId counter). This step
introduces an `AccountContext` that owns all per-account state and refactors the
cache/identifier/queue/`wa` modules to receive it instead of importing module
singletons. **Largest refactor; must merge as one PR.**

## Contract references
- **CONTRACT.md §5** — finalizes the `AccountContext` interface that Step 09
  declared as a placeholder. `AccountContext` fields are an internal Node detail
  (intentionally not on the wire), but the exported type name must match §5.

## Files to read before starting
- Original - `migration/node/caches.ts`, `migration/node/identifiers.ts` (Step 06)
- `migration/node/wa/sendQueue.ts` (Step 10)
- `migration/node/wa/outbound.ts`, `migration/node/wa/inbound.ts`, `migration/node/wa/events.ts` (Step 12)
- `migration/node/wa/interactive/*.ts` (Step 10)
- `migration/node/protocol/types.ts` (the `AccountContext` placeholder)

## Files to create
### `migration/node/account/accountContext.ts`
**Purpose:** Per-account state holder + factory.
**Exports:**
- `interface AccountContext` (the concrete fields: the former `caches.ts`
  `Map`/`Set`s, the contextMsgId counter map, the senderRef registry, a
  per-context `withJidQueue`, `quizMessageIds`, group metadata cache).
- `createAccountContext(folderPath: string): AccountContext`
**Must NOT contain:** Baileys socket creation (Step 17), DB access, WS logic.
**Key logic:** each `createAccountContext` returns fresh, independent state.
Replaces the module-global singletons that lived in `caches.ts`.

## Files to modify
### `migration/node/caches.ts`
**Change:** Move the singleton `Map`/`Set`s into `AccountContext`; `caches.ts`
keeps only `cacheSetBounded`, `GROUP_JOIN_STUB_TYPES`, and bound constants.

### `migration/node/identifiers.ts`
**Change:** Each function (`nextContextMsgId`, `rememberSenderRef`,
`rememberMessage`, `resolveQuotedMessage`, `rememberMessageKeyIndex`, …) takes an
`AccountContext` (first param or via a bound factory) instead of reading globals.
Pure helpers (`normalizeJid`, `normalizeContextMsgId`, `makeSenderRef`) stay
static.

### `migration/node/wa/sendQueue.ts`
**Change:** `withJidQueue` operates on the context's queue map (so two accounts
serialize the same `chatId` independently).

### `migration/node/wa/{outbound,inbound,events}.ts`, `migration/node/wa/interactive/*.ts`
**Change:** Thread the `AccountContext` through every identifier/cache/queue call
site. No behavioral change beyond per-account isolation.

## Files to delete
- The module-global state in `caches.ts` (relocated, not kept).

## Acceptance criteria
- `pnpm typecheck` passes with zero errors.
- `tests/node/account-context.test.ts`: two `AccountContext`s with the **same**
  `chatId` keep **independent** contextMsgId counters (both start at `000000`)
  and independent senderRef registries (same `(chatId, senderId)` may map to
  different refs / does not leak across contexts).
- Existing identifier tests adapted to pass a context, still pass.
- `node --test` green.

## Must NOT do
- Do not create the Baileys socket or registry binding here (Step 17).
- Do not change wire shapes or DB paths.
- Do not split this across multiple PRs — the call-site edits and the new type
  must land together.

## Depends on
Step 15 (and supersedes the singleton assumptions of Steps 06/10/12).
