# Step 10 Verification — TypeScript: `wa/` leaves (`utils`, `sendQueue`, `interactive/*`)

## 1. Verdict: ACCURATE

The `wa/` leaf modules were converted to TypeScript with proper types, and the
original `.js` files are gone. Logic, proto construction, and `additionalNodes`
are byte-for-byte equivalent to the original `src/wa/` sources. The one nuance:
`sendQueue.ts` now keys by `ctx.jidQueues` (per-account) — this is the documented
**Step 16** evolution layered onto the final repo state, not a Step 10 defect or
a contract violation (it strengthens per-tenant isolation; see Notes).

## 2. Acceptance-criteria checklist

| Criterion | Status | Evidence |
|-----------|--------|----------|
| `utils.js` → `utils.ts`, types added (`withTimeout`, `runWithConcurrency`, `escapeRegex`) | PASS | `migration/node/wa/utils.ts` — all three typed with generics; logic identical to `src/wa/utils.js`. (No standalone semaphore export exists in the original either; nothing lost.) |
| `sendQueue.js` → `sendQueue.ts`, `withJidQueue<T>` typed | PASS | `migration/node/wa/sendQueue.ts:36` — typed `withJidQueue<T>(ctx, jid, fn): Promise<T>`; promise-chain behavior unchanged. |
| `interactive/*.js` → `*.ts`, all builders typed | PASS | `sendInteractive.ts`, `sendButtons.ts`, `sendCarousel.ts` all converted with typed signatures; barrel `index.ts` converted. |
| Barrel `index.ts` re-exports unchanged | PASS | `interactive/index.ts` exports identical set as original `index.js`. |
| `.js` originals deleted | PASS | `ls` finds no `.js` under `migration/node/wa/` or `migration/node/wa/interactive/`. |
| Logic unchanged (proto/additionalNodes) | PASS | `buildInteractiveNodes`, `_sendInteractive`, all builders match originals exactly. |
| `pnpm typecheck` passes (zero errors) | PASS (static) | `AccountContext.jidQueues: Map<string, Promise<void>>` exists (`accountContext.ts:80`); callers pass `ctx` (`actionDispatcher.ts:207`, `broadcast.ts:30,115`). Imports use `.js` ESM specifiers. No obvious type errors. Not executed per read-only rule. |
| `pnpm dev` boots / `send_quiz` reaches `sendQuickReply` | PASS (static) | Wiring intact via barrel + actionDispatcher; not executed per read-only rule. |
| `node --test` passes | NOT RUN | Per read-only/parallel-safety rules; orchestrator runs global gates. |

## 3. Issues

None (BLOCKER/MAJOR/MINOR): none found.

- All converted files reproduce the original behavior precisely; only type
  annotations and (in `sendQueue.ts`) the Step-16 `ctx` parameter were added.
- `sock.user!.id` non-null assertion in `_sendInteractive` is benign (original
  used `sock.user.id`).
- `as unknown as AnyMessageContent` casts in `sendList`/`sendButtons` are
  deliberate to satisfy Baileys' content union for legacy list/buttons messages.

## 4. Notes on 'Must NOT do' / isolation / contract

- **"Do not change `withJidQueue` to key by `(folderPath, jid)` (Step 16)"** —
  The final-state `sendQueue.ts` *does* take an `AccountContext` and use
  `ctx.jidQueues`. This is **not** a Step 10 violation: in the sequentially
  applied migration, Step 16 explicitly performs this change, and the audited
  repo reflects all steps. The result is per-account JID-queue isolation
  (two tenants serialize the same `chatId` independently) — an isolation
  improvement, not a leak.
- **"Do not change interactive proto/`additionalNodes` construction"** —
  Respected. `buildInteractiveNodes` (biz/native_flow + bot node for private
  chats) and the `viewOnceMessage` wrapper are unchanged (CONTRACT.md §1.2; no
  wire change).
- **"Do not convert outbound/actions/connection here"** — Out of scope; those
  exist as separate `.ts` files (Steps 12–13) and were not touched by this step.
- No shared mutable cross-tenant state introduced; `utils.ts` and the
  interactive builders are pure/stateless. `jidQueues` lives on per-account
  `AccountContext`.
