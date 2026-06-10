# Step 30 — Delete Node `wsClient.ts` — Verification Report

## (1) Verdict: ACCURATE

## (2) Acceptance-criteria checklist

| Criterion | Result | Evidence |
|---|---|---|
| `git grep -n "wsClient" migration/node/` returns **zero** matches | PASS | Ran `git grep -n "wsClient" migration/node/` → empty output. |
| `migration/node/wsClient.ts` deleted | PASS | `ls migration/node/wsClient.ts` → "No such file or directory". `find migration -iname '*wsclient*'` → none. |
| `getSock()`/global-`sock` shim removed from `connection.ts` | PASS | `git grep "getSock\|let sock"` in migration/node yields only doc comments referencing the *removed* accessor (accountContext.ts, actionDispatcher.ts, baileysFactory.ts, parseCommand.ts). No live `getSock`/global `sock` declaration. `baileysFactory.ts:87 let socketCreator` is an unrelated injectable factory, not the shim. |
| `config.ts` `wsEndpoint` removed | PASS | `git grep "wsEndpoint" migration/node/` → zero matches; not present in `Config` interface or `config` object. |
| `wsListenPort` / `wsToken` kept | PASS | config.ts:54-55 (interface) and config.ts:86-87 (values) retain both. |
| `wsReconnect*` removed if unreferenced | PASS | `git grep "wsReconnect\|WS_RECONNECT" migration/node/` → zero matches. Fully removed; no dangling reference. |
| `wsHeartbeat*` kept only if referenced | PASS | `wsHeartbeatIntervalMs` retained (config.ts:61,93) and still referenced by `server/wsServer.ts:173`. Correct per spec. |
| No dangling wsclient test (intent moved to Python `test_transport.py`) | PASS | No `*wsclient*` test under `tests/node/` or `migration`. `migration/node/tests/` does not exist; node tests live in `tests/node/`. `test_transport.py:43` documents the ported coverage. |
| `node --test` green (no test references deleted client) | NOT RUN (per strict rules) | No test imports `wsClient`; only a stale code-comment at `tests/node/control-events.test.ts:133` mentions "wsClient fallback" (comment text, not an import). |
| `pnpm typecheck` passes | NOT RUN (per strict rules) | No dangling import found by static read; `index.ts` imports `./server/wsServer.js` only. Plausibly green. |
| `pnpm dev` boots normally | NOT RUN (per strict rules) | Server bootstrap (`index.ts` → `startWsServer`) intact. |

## (3) Issues

- [MINOR] tests/node/control-events.test.ts:133 — Stale code comment references "default-account wsClient fallback". Harmless (a comment, not an import; outside `migration/node/` so it does not break the zero-match acceptance criterion). Could be cleaned for clarity but is not a spec violation.

## (4) Must NOT do / isolation / contract notes

- "Do not touch Python `wasocket/transport.py`": NOT violated. The remaining `wsClient` references in `migration/python/wasocket/transport.py` (lines 4,59,72,116,153,202,213,243,283,344,363,457) and `test_transport.py:43` are documentation comments describing the 1:1 port; they are expected and untouched.
- "Do not remove `wsListenPort`/`wsToken`": NOT violated — both retained.
- "Do not change server behavior": NOT violated — `wsServer.ts` heartbeat logic and `index.ts` server bootstrap unchanged; only the dead client/config were removed.
- No per-account isolation, frame-shape, folderPath, or reliable/best-effort concerns are in scope for this deletion-only step; none introduced.

## Summary of what was checked
Confirmed the file deletion, zero residual `wsClient` references in `migration/node/`, removal of the `getSock`/global-`sock` shim, removal of `wsEndpoint` and `wsReconnect*` config, retention of `wsListenPort`/`wsToken`, and correct retention of `wsHeartbeatIntervalMs` (still referenced by the server). All acceptance criteria verifiable by static reading are satisfied. Build/test gates were not run per the strict read-only/parallel-safety rules.
