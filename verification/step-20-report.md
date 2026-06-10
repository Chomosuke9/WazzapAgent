# Step 20 — `wsServer.ts` — Verification Report

## 1. Verdict: ACCURATE

The inbound WS server (`migration/node/server/wsServer.ts`) and the `config.ts`
addition match the spec and CONTRACT.md §1.1–§1.5 / §8. All four scripted
acceptance behaviors are satisfiable by the code as written; delegation
boundaries are respected (no inline Baileys creation, action routing, or event
normalization). Only one theoretical-race MINOR was found.

## 2. Acceptance-criteria checklist

| Criterion | Status | Evidence |
|---|---|---|
| `migration/node/server/wsServer.ts` exists, exports `startWsServer` | PASS | `export function startWsServer(port = config.wsListenPort): WebSocketServer` (wsServer.ts:80) |
| Optional `Authorization: Bearer <LLM_WS_TOKEN>` check | PASS | `authorizeUpgrade` + `verifyClient` → `cb(false, 401, 'Unauthorized')` (wsServer.ts:62–101). No token configured → accept all. |
| First frame must be `hello`; else close | PASS | `handleHello` rejects non-`hello` with `ws.close(1002,'expected hello')` (wsServer.ts:~210) |
| `createOrResumeAccount({folderPath})` on hello | PASS | wsServer.ts (handleHello) calls delegated factory; folder layout ensured there (CONTRACT §8) |
| Send `hello_ack {folderPath, waStatus}` | PASS | `{type:'hello_ack', payload:{folderPath, waStatus: entry.waStatus}}` matches HelloAckPayload / CONTRACT §1.1 |
| `bindClient` + `flushReliableQueue` | PASS | hello_ack sent BEFORE `registry.bindClient` (which flushes), then explicit `flushReliableQueue` (no-op) — guarantees ack precedes queued frames |
| Subsequent frames → `dispatchAction(entry, frame)` | PASS | message handler routes to `dispatchAction` after lookup `registry.get(folderPath)` (wsServer.ts:~133) |
| On `close`: `unbindClient`, keep Baileys socket alive | PASS | close handler only `registry.unbindClient(folderPath)`; no sock teardown (wsServer.ts:~150) |
| Server-side heartbeat (`isAlive` ping/terminate, `WS_HEARTBEAT_INTERVAL_MS`) | PASS | canonical single-interval pinger/reaper; `heartbeat.unref()`; `wss.on('close')` clears interval (wsServer.ts:~163) |
| `config.ts`: add `wsListenPort` (`WS_LISTEN_PORT`, default 3000) | PASS | `wsListenPort: positiveInt(process.env.WS_LISTEN_PORT, 3000)` + Config interface field |
| Test: hello → hello_ack | PASS (static) | tests/node/ws-server.test.ts test 1 |
| Test: send_message → action_ack + send_ack | PASS (static) | test 2; dispatcher emits both for ok send_message |
| Test: missing/invalid auth rejected | PASS (static) | test 3 |
| Test: reconnect flush after hello_ack | PASS (static) | test 4; ordering guaranteed by ack-before-bind |
| Must NOT contain Baileys creation / action handling / event normalization | PASS | all delegated (imports `createOrResumeAccount`, `dispatchAction`; no inline normalization) |

`pnpm typecheck` / `node --test` not run (per orchestrator rules; global gates
run centrally). Judged from static reading only.

## 3. Issues

- [MINOR] migration/node/server/wsServer.ts:~120 (message handler) — Handshake
  race: `ws.helloDone` is set `true` only AFTER `await createOrResumeAccount`
  inside `handleHello`. If a client sends a second frame while the first
  `handleHello` is still awaiting account creation, the gate `if (!ws.helloDone)`
  re-enters `handleHello` with that frame; a non-`hello` frame then closes the
  socket (1002), and a duplicate `hello` would re-run create/ack/bind. In
  practice the `WaSocket` SDK waits for `hello_ack` before sending actions, so
  this is not reachable by the bundled client; flagged for completeness.

- [MINOR] spec-vs-tree mismatch (not a code defect) — Step 20 says "do not remove
  `wsEndpoint`" and acceptance includes "`pnpm dev` (old path) still works." The
  migration Node tree has **no** `wsEndpoint` config key and **no** Node-side
  `wsClient.ts` (only the Python port `migration/python/wasocket/transport.py`).
  There is no legacy outbound client path in `migration/node` to preserve, so
  these clauses are vacuously satisfied. `config.ts` correctly does not contain
  `wsEndpoint`.

## 4. Must-NOT-do / isolation / contract notes

- "Do not tear down the Baileys socket on client disconnect" — RESPECTED. The
  `close` handler only unbinds the client; reconnect test asserts
  `get(folderPath)?.sock` survives.
- "Do not re-implement action routing or event normalization inline" — RESPECTED.
- "Do not modify `index.ts` boot (Step 28)" — `index.ts` DOES now import and call
  `startWsServer`. This is the **Step 28** atomic flip and is the correct final
  repository state; it is not a Step 20 deliverable and not a violation of the
  audited final tree. `index.ts` shutdown closes `wss` cleanly (teardown OK).
- Per-tenant isolation: each connection binds to its own `folderPath`
  `AccountEntry`; no shared mutable state across tenants in `wsServer.ts`. The
  heartbeat iterates `wss.clients` only for liveness. Reliable-queue routing is
  per-account via the registry. No isolation leak found.
- Contract conformance: `hello_ack` shape (payload-wrapped, `{folderPath,
  waStatus}`) matches CONTRACT §1.1; reliable-after-handshake ordering matches
  §1.6; control events remain top-level (untouched here). No protocol violation.
