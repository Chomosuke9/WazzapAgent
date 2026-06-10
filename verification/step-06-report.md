# Step 06 Verification — TypeScript: `caches`, `identifiers`

## (1) Verdict: ACCURATE

The Step 06 goal — convert `caches.js` and `identifiers.js` to fully-typed
TypeScript — is fully achieved in the final tree. Both files were renamed to
`.ts`, the `.js` originals are deleted, every `Map`/`Set`/`cacheSetBounded`/
function is typed, and the behavior-critical logic (senderRef derivation,
contextMsgId wrap, `GROUP_JOIN_STUB_TYPES` filter) is preserved byte-for-byte.

IMPORTANT CONTEXT: Step 06's spec describes a *type-only* conversion that leaves
the module-singleton design intact, deferring the per-account refactor to Step
16. The audited (final) tree already contains the **Step 16** `AccountContext`
refactor layered on top: `caches.ts` no longer exports the singleton
`Map`/`Set` instances (they now live on `AccountContext`), and `identifiers.ts`
takes `ctx: AccountContext` as the first parameter of every stateful function.
This is *expected* when auditing the post-migration final state — it is Step
16's legitimate work, not a Step 06 defect. The type-conversion deliverable of
Step 06 is intact within that final code, and the two behavior-preservation
"Must NOT do" items (senderRef derivation, contextMsgId wrap) are honored.

## (2) Acceptance-criteria checklist

- [PASS] `caches.js` → `caches.ts` rename: file exists, fully typed
  (`MessageIndexKey`, `MessageIndexEntry`, `SenderRefRegistry`,
  `GroupContextValue`, etc., `cacheSetBounded<K,V>`).
- [PASS] `identifiers.js` → `identifiers.ts` rename: file exists, all functions
  typed; export surface identical to original (all 20 symbols).
- [PASS] `migration/node/caches.js` deleted (glob shows only `.ts`).
- [PASS] `migration/node/identifiers.js` deleted (glob shows only `.ts`).
- [PASS] `GROUP_JOIN_STUB_TYPES` preserved exactly, typed as `Set<number>`,
  same `.filter(Number.isInteger)` guard.
- [PASS] senderRef derivation unchanged (`makeSenderRef`: SHA1(chatId|senderId|
  attempt) → base36 → padStart(6) → slice(6), identical to original).
- [PASS] contextMsgId wrap unchanged (`nextContextMsgId`: `current % 1_000_000`,
  store `(bounded+1)%1_000_000`, `String(bounded).padStart(6,'0')`).
- [PASS — static] No stale imports of removed singletons anywhere in
  `migration/` (grep for `messageCache|groupMetadataCache|...` from `caches`
  returns 0 matches); 12 consumers import from `identifiers.js`. Imports
  resolve; `AccountContext` provides every field identifiers.ts references
  (messageCache, messageKeyIndex, messageIdToContextId, contextCounterByChat,
  senderRefRegistryByChat). Strongly indicates `pnpm typecheck` passes for
  these files. (Did not run `tsc`/`pnpm dev`/`node --test` per the read-only,
  no-global-gates rule; judged statically.)
- [NOT RUN] `pnpm dev` boots / inbound gets contextMsgId — runtime criterion;
  not executed (read-only). Static read shows the code path is intact.
- [NOT RUN] `node --test` — not executed (read-only).

## (3) Issues list

None at BLOCKER/MAJOR. The conversion is correct, consistent, and well-typed.

- [MINOR] Spec/implementation drift (informational, not a defect):
  `migration/node/caches.ts:1` and `migration/node/identifiers.ts` contain the
  Step 16 `AccountContext` refactor that Step 06's "Must NOT do #1" forbids for
  Step 06 itself. This is correct for the final audited tree (Step 16 owns that
  change). Anyone reading the Step 06 spec in isolation should be aware the live
  code has already advanced past Step 06's intermediate state.

## (4) Must-NOT-do / isolation / contract notes

- "Do not change the senderRef derivation or contextMsgId wrap behavior" —
  HONORED. Both are byte-identical to `src/identifiers.js`.
- "Do not change the module-singleton design (no AccountContext yet — Step 16)"
  — superseded by Step 16 in the final tree (expected). The result is an
  *improvement* for multi-account isolation: `createAccountContext()` returns
  fresh independent collections, so two accounts no longer share one
  contextMsgId counter / senderRef registry for the same `chatId`. No
  cross-tenant shared mutable state remains in `caches.ts` (it is now purely
  stateless: constants, `cacheSetBounded`, `GROUP_JOIN_STUB_TYPES`, types).
- "Do not convert any other file" — N/A in final-tree audit (all files are
  converted by their own steps).
- No wire-protocol surface here (Step 06 touches no frames); CONTRACT.md §7
  contextMsgId semantics are preserved.
- No socket/interval/server teardown concerns in these leaf modules.
