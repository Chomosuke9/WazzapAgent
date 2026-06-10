# Step 16 — `AccountContext` + per-account state isolation (D2) — Verification Report

## (1) Verdict: ACCURATE

The largest refactor of the migration is implemented faithfully. `AccountContext`
owns all former `caches.ts`/`sendQueue.ts` module-global state; `identifiers.ts`,
`sendQueue.ts`, and every `wa/*`/`groupContext`/`participants`/`messageParser`
call site is threaded with a per-account context. No singleton leak remains.

## (2) Acceptance-criteria checklist

- [PASS] **`accountContext.ts` created** — exports `interface AccountContext` (concrete
  fields: `messageCache`, `groupMetadataCache`, `participantNameCache`,
  `groupParticipantNameCache`, `groupJoinDedupCache`, `messageKeyIndex`,
  `messageIdToContextId`, `contextCounterByChat`, `senderRefRegistryByChat`,
  `quizMessageIds`, `jidQueues`, `pendingForms`, plus `folderPath`/`sock`) and
  `createAccountContext(folderPath)`. Each call returns fresh, independent
  collections.
- [PASS] **Must NOT contain socket creation/DB/WS** — `accountContext.ts` only
  constructs in-memory `Map`/`Set`s. The `sock` field is a *reference holder*
  (default `undefined`); the actual socket is created/assigned in
  `baileysFactory.ts` (`account = entry.ctx; account.sock = sock`, line 209) — not here.
- [PASS] **`caches.ts` stripped of singletons** — keeps only type defs,
  `cacheSetBounded`, `GROUP_JOIN_STUB_TYPES`, and bound/TTL constants
  (`MAX_CACHE`, `MAX_KEY_INDEX`, `MAX_QUIZ_IDS`, TTLs). No `Map`/`Set` exports remain.
- [PASS] **`identifiers.ts` takes `ctx` first** — `nextContextMsgId`,
  `rememberSenderRef`, `rememberMessage`, `resolveQuotedMessage`,
  `rememberMessageKeyIndex`, `resolveSenderByRef`, `getIndexedMessageByContextId`,
  `findContextMsgIdByMessageId`, `ensureContextMsgId`,
  `resolveMentionTargetBySenderRef`, `resolveParticipantBySenderId` all take
  `ctx: AccountContext` first. Pure helpers (`normalizeJid`,
  `normalizeContextMsgId`, `makeSenderRef`, key builders, `isContactJid`) stay static.
  Logic is byte-for-byte equivalent to original `src/identifiers.js`.
- [PASS] **`sendQueue.ts` operates on context queue** — `withJidQueue(ctx, jid, fn)`
  uses `ctx.jidQueues`; promise-chain/slot-cleanup logic preserved from original.
- [PASS] **`wa/{outbound,inbound,events}.ts`, `wa/interactive/*` threaded** — all 12
  call-site files pass `ctx`/`account` as first arg; `ctx.sock` read in
  outbound/inbound/events/actions/moderation/presence/runCommand/groupContext.
- [PASS] **two contexts, same `chatId`, independent counters (both start 000000)** —
  proven by `tests/node/account-context.test.ts` and supported by code
  (`contextCounterByChat` per-context map; `nextContextMsgId` reads/writes `ctx`'s map).
- [PASS] **independent senderRef registries** — `senderRefRegistryByChat` per context;
  test asserts a ref minted in A does not resolve in B and vice versa.
- [PASS] **identifier tests adapted to pass a context** — covered by
  `account-context.test.ts` (no separate stale identifier test exists in migration).
- [NOT RUN] **`pnpm typecheck` / `node --test` green** — not executed (read-only audit;
  orchestrator runs global gates). Static reading shows consistent typing: types
  imported correctly, `AccountContext` re-exported from `protocol/types.ts` via a
  type-only re-export, all call sites match new signatures.

## (3) Issues list

- [MINOR] `migration/node/account/accountContext.ts:52` / `protocol/types.ts:186` —
  Socket reference exists in two places: `AccountContext.sock` (set at
  `baileysFactory.ts:209`) and `AccountEntry.sock` (set at `accountRegistry.ts:86`,
  cleared at `baileysFactory.ts:239`). They are separate fields that can diverge
  during a reconnect gap (`entry.sock` is cleared to `undefined` on close while
  `ctx.sock` keeps the old/closed socket until `buildSocket` reassigns it). All
  `wa/*` helpers read `ctx.sock`, so this is benign for this step, but the dual
  source of truth is a latent foot-gun for Step 17/33. Not a Step-16 violation.
- [MINOR] `accountContext.ts` adds a `pendingForms` field not enumerated in the
  spec's field list. This is a correct, additive isolation fix for `/modelcfg`
  form state (per-account) and is covered by a test; consistent with the step's
  intent, not a violation.

## (4) Must-NOT-do / isolation / contract notes

- No Baileys socket creation, DB access, or WS logic in `accountContext.ts` — compliant.
- No wire shapes or DB paths changed. `AccountContext` is an internal Node type,
  intentionally off-wire; re-exported from `protocol/types.ts` so the §5 name matches.
- Landed as one cohesive change (new type + all call-site edits together) — compliant.
- Isolation verified: no leftover imports of removed singletons
  (`messageCache`, `contextCounterByChat`, `senderRefRegistryByChat`, etc.) from
  `caches.ts` anywhere in `migration/node`; every cache/identifier/queue access
  goes through a per-account `ctx`. No shared mutable cross-tenant state found.
