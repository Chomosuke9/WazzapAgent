# Step 15 Verification — `accountRegistry.ts`

## (1) Verdict: ACCURATE

The implementation at `migration/node/server/accountRegistry.ts` fully satisfies
the Step 15 spec and CONTRACT.md §5/§1.6. All required exports exist, the
reliable/best-effort queue semantics mirror `LLMWebSocket` (`src/wsClient.js`),
the test file covers every acceptance case, and no "Must NOT do" constraint is
violated.

## (2) Acceptance-criteria checklist

| Criterion | Result |
|---|---|
| `pnpm typecheck` passes (judged statically) | PASS (see notes) |
| Test: `getOrCreate` idempotent (same object per folderPath) | PASS — `getOrCreate` returns cached entry; test asserts `strictEqual`. |
| Test: reliable enqueue w/ no client, then `bindClient` + `flushReliableQueue` delivers in order | PASS — FIFO via `push`/`splice`; test asserts 3 frames in order. |
| Test: pushing > 1000 reliable frames drops oldest (len ≤ 1000) | PASS — `push` then `shift` when `length > MAX_RELIABLE_QUEUE`; test pushes 1050, asserts len==1000, head==`frame-50`. |
| Test: `sendToClient` with no client is a no-op (no throw, no enqueue) | PASS — early return before any queue mutation; test asserts no throw + no enqueue. |
| `node --test` green | PASS (judged statically; not run per directive) |

### Exports required vs present
All present: `getOrCreate`, `get`, `bindClient`, `unbindClient`, `bindSock`,
`list`, `remove`, `sendToClient`, `sendReliableToClient`, `flushReliableQueue`,
`MAX_RELIABLE_QUEUE = 1000`. PASS.

### Files
- Create `migration/node/server/accountRegistry.ts`: EXISTS, matches purpose. PASS.
- Modify: None. PASS.
- Delete: None. PASS.

## (3) Issues list

- [MINOR] accountRegistry.ts:138 — On overflow the warn log reports
  `queueSize: entry.reliableQueue.length` *after* the `shift()`, so it always
  logs `1000` rather than the pre-trim `1001`. Cosmetic only; no functional
  impact.
- [MINOR] accountRegistry.ts:115,148 — Uses `frame?.type` optional chaining on a
  parameter typed as non-optional `OutboundFrame`. Harmless defensive code; not
  a bug.

No BLOCKER or MAJOR issues found.

## (4) Must NOT do / isolation / contract notes

- "Do not import or start `ws.Server`": COMPLIANT — only `import WebSocket from
  'ws'` (default class import, used for `WebSocket.OPEN` and `readyState`
  comparison, mirroring `src/wsClient.js`). No `WebSocketServer`/`Server`.
- "Do not create Baileys sockets / touch connection.ts": COMPLIANT — `bindSock`
  only stores the reference (`sock` typed via `AccountEntry['sock']`, a
  type-only `import("baileys").WASocket`).
- "Do not define AccountContext's real fields": COMPLIANT — `ctx` is stored as
  an opaque `{} as AccountContext` placeholder; the type is re-exported from
  `account/accountContext.js` (Step 16) via `protocol/types.ts`.
- "Do not wire into index.ts boot": COMPLIANT — `index.ts` imports only
  `startWsServer` (Step 20); accountRegistry is not referenced from boot. Later
  steps (wsServer, eventForwarder) import it, which is expected and out of scope.
- Per-tenant isolation: COMPLIANT — module-private `Map<folderPath, AccountEntry>`,
  each entry owns its own `reliableQueue: []` array and `ctx`. No mutable state
  shared across tenants. `remove()` drops the entry and its queue; `unbindClient`
  retains the queue (correct per spec: queued frames survive reconnect).
- Reliable vs best-effort (CONTRACT §1.6): COMPLIANT — `sendReliableToClient`
  sends immediately when client OPEN else enqueues (bounded, drop-oldest);
  `sendToClient` drops silently if no OPEN client and never enqueues.
- `clientIsOpen` type guard uses `WebSocket.OPEN`; `entry.client`
  (`import("ws").WebSocket`) and the default `ws` import resolve to the same
  class, so the guard typechecks.
