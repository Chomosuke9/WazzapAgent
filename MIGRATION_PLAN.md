# Migration Plan — WaSocket SDK + TypeScript

## Goal

Turn the Node gateway into a **multi-account WS server** and the Python bridge
into one-or-more **WaSocket SDK clients**, while migrating the entire Node
codebase to TypeScript. End state:

```python
sock1 = make_wa_socket(folder_path="/data/account_1")
sock2 = make_wa_socket(folder_path="/data/account_2")
await sock1.connect("ws://localhost:3000")
await sock2.connect("ws://localhost:3000")

@sock1.on("message")
async def handle1(msg): await sock1.send_message(...)
```

Node routes every Baileys event and every inbound action to the correct
account by `folderPath`. Node keeps command handling, interactive messages,
and the send queue. The Python agent logic in `python/bridge/` is unchanged
except for the seam where it talks to the socket.

---

## Current topology (baseline)

```
Python (websockets.serve, main.py handle_socket)  ←── WS ───  Node (wsClient.js, client)
        SERVER                                                CLIENT
        - one handle_socket(ws) per Node connection           - one global Baileys sock
        - owns all per-chat agent state                       - getSock() global
        - sends actions via ws.send (fire-and-forget)         - dispatchCommand() routes actions
        - receives action_ack/error/control as events         - emits incoming_message / control via send/sendReliable
```

Target topology reverses the WS direction and makes Node multi-account:

```
Python WaSocket client(s)  ─── WS ──→  Node wsServer (server)
   one per folder_path                  accountRegistry: folderPath → { sock, client }
   - SDK: connect/reconnect/backoff      - baileysFactory creates/resumes per-folder sock
   - on("message"/"status"/control)      - eventForwarder: Baileys events → client (folderPath-tagged)
   - await sock.send_message(...)        - actionDispatcher: action frame → account sock → ack
```

---

## Cross-cutting design decisions (read before executing)

These three decisions shape multiple steps. They are settled here so individual
steps can reference them.

### D1 — `folderPath` is the account key; connection identity is implicit

Each `WaSocket` owns its own WS connection, so a connection already identifies
one account. `folderPath` is still included in the handshake (`hello`) and
stamped onto every Node→Python event payload (belt-and-suspenders + lets the
SDK assert it is receiving its own account's traffic). The Node
`accountRegistry` keys on `folderPath`; the per-folder Baileys auth directory
is derived from it (`<folderPath>/auth` by default, replacing the single global
`config.authDir`).

### D2 — Per-account state isolation on Node (the biggest refactor)

Today `src/caches.js` exposes module-level `Map`s keyed by `chatId` only
(`messageCache`, `messageKeyIndex`, `messageIdToContextId`,
`contextCounterByChat`, `senderRefRegistryByChat`, `quizMessageIds`, group
metadata caches). With N accounts, `chatId` can collide across accounts (two
accounts in the same group; or `__unknown_chat__`), and the contextMsgId
counter would be shared. `src/identifiers.js` reads those module maps directly,
and `wa/outbound.js`, `wa/inbound.js`, `wa/events.js`, `wa/interactive/*` all
call identifier functions.

**Decision:** introduce an `AccountContext` object (created by `baileysFactory`
per `folderPath`) that owns: the Baileys `sock`, the per-account cache `Map`s,
the per-account `senderRef`/contextMsgId registries, and the per-account JID
send-queue. The `identifiers`, `caches`, `sendQueue`, `outbound`, `inbound`,
and `events` modules are refactored from "import global singletons" to
"receive an `AccountContext`". This is done as one dedicated step (Step 3.3)
because it touches every call site. DBs (`settings/stats/moderation/subagent/
stickers`) stay **shared** and keyed by `chatId` — splitting them per-account
is out of scope (flag: a future need to disambiguate identical `chatId`s across
accounts in the DB would require a `folderPath`/`instanceId` column).

### D3 — Ack correlation: await-on-ack vs ack-as-event

Today the agent fire-and-forgets actions (`await ws.send(...)`) and handles
`action_ack`/`send_ack`/`error` **as events** in the `async for raw in ws`
loop. For `send_message` it uses `pending_send_request_chat` + the
`local-send-<request_id>` provisional history entry, hydrating the real
`contextMsgId` via `_hydrate_provisional_context_id_from_ack`
(`processing.py`).

The SDK's `correlation.py` (pending-futures dict) implies `await
sock.send_message(...)` should **resolve with the ack result**. These conflict.

**Decision (primary):** SDK action methods generate a `requestId`, register a
future, send the frame, and `await` the matching `action_ack`/`error`
(with timeout), returning the `result` dict (e.g. the `sent[]` array) or
raising a `WaSocketError`. **Additionally**, the SDK re-emits `action_ack`,
`send_ack`, and `error` as events. This lets Phase 5 choose, per call site,
between:

- **(a) await-return** — simplest for new code; `send_message` returns the
  `contextMsgId` directly, so provisional hydration can be done inline.
- **(b) keep-as-event** — the existing main.py hydration handlers keep working
  verbatim by subscribing to the re-emitted `action_ack` event.

Phase 5 uses **(b) for `send_message`/sub-agent attachment hydration** (lowest
risk, agent logic unchanged) and **(a) where a return value is convenient**.
This is called out again in Step 5.2.

`mark_read` and `send_presence` never receive an ack — their SDK methods do not
register a future and return after the frame is written.

---

## Phase 0 — Cleanup

### Step 0.1 — Delete dead Python `commands.py`
**What:** `python/bridge/commands.py` (legacy slash handler) is dead. `main.py`
imports `parse_command`/`handle_command`/`CommandResult` **only** in the
`except ImportError` fallback branch (`from bridge.commands import ...`); the
primary relative-import branch never imports it, and `process_message_batch`
routes all slash commands through Node (`commandHandled`) plus inline
`/reset`, `/dump`, `/sticker`. Delete the file and remove the fallback-branch
import lines so the two import branches match.
**Source:** `python/bridge/commands.py` (whole file); `python/bridge/main.py`
fallback import block (`from bridge.commands import parse_command, handle_command, CommandResult`).
**Target:** `python/bridge/main.py` (import block only).
**Deleted:** `python/bridge/commands.py`.
**Contract change:** none (no wire-format or behavior change).
**Test:** `python -m python.bridge.main` boots under both invocation styles
(`python -m python.bridge.main` and `python python/bridge/main.py`); `grep -r
"bridge.commands\|import commands\|parse_command\|handle_command" python/`
returns nothing. Existing bridge smoke test (echo server) still processes a
`/help` and a plain message.
**Depends on:** none.

### Step 0.2 — Dead-reference audit
**What:** Confirm no other modules import `commands` and capture any obviously
orphaned helpers exposed only for it. Pure verification + tiny deletions; no
behavior change.
**Source:** repo-wide grep.
**Target:** none beyond what 0.1 removed.
**Deleted:** any confirmed-orphan symbol surfaced by the grep (expected: none).
**Contract change:** none.
**Test:** bridge boots; `node --test` and bridge smoke test green.
**Depends on:** 0.1.

---

## Phase 1 — TypeScript Setup

Goal: make `.ts` and `.js` coexist and runnable so Phase 2 can convert one file
at a time without breaking `pnpm dev`.

### Step 1.1 — Add TS toolchain + `tsconfig.json`
**What:** Add dev deps `typescript`, `tsx`, `@types/node`, `@types/ws` (pin
exact versions). Add `tsconfig.json`: `module: NodeNext`,
`moduleResolution: NodeNext`, `target: ES2022`, `allowJs: true`,
`checkJs: false`, `strict: true`, `noEmit` for type-check + a `dist` build
config, `esModuleInterop: true`, `resolveJsonModule: true`. Keep
`"type": "module"`. Update `package.json` scripts: `dev`/`start` run the entry
through `tsx` (so a `.ts` entrypoint and `.js` imports both load); add
`typecheck: tsc --noEmit`. `postinstall` baileys patch unchanged.
**Source:** `package.json` (scripts + deps); repo root (new `tsconfig.json`).
**Target:** `package.json`, `tsconfig.json` (new).
**Deleted:** none.
**Contract change:** none (runtime identical; still ESM).
**Test:** `pnpm install` succeeds; `pnpm dev` still boots the gateway from the
existing `src/index.js`; `pnpm typecheck` runs (allowJs, so JS files are not
errored). `node --test` still green.
**Depends on:** none.

### Step 1.2 — Test runner + ambient declarations for TS
**What:** Make the test command run `.ts`/`.mjs` tests (either `node --test`
with `tsx` loader, or add `vitest`; pick the lower-friction option for this
repo — `node --test --import tsx`). Add `src/types/ambient.d.ts` for any
dependency lacking types after install (verify `baileys`, `better-sqlite3`,
`fs-extra`, `pino`, `sharp`, `fluent-ffmpeg` type availability first; declare
only the gaps). Keep the existing `tests/node/**/*.test.mjs` running.
**Source:** `package.json` `test` script; existing `tests/node/`.
**Target:** `package.json`, `src/types/ambient.d.ts` (new, only if gaps exist).
**Deleted:** none.
**Contract change:** none.
**Test:** existing `tests/node/**` pass via the new runner; a trivial
`*.test.ts` compiles and runs.
**Depends on:** 1.1.

---

## Phase 2 — JS → TS Migration (leaf-first, one file/group per step)

Rule: convert leaves before consumers so each step type-checks against
already-typed deps. After each step the system runs unchanged (`allowJs` keeps
not-yet-converted files working). No behavior changes — types only. Every step's
test is: `pnpm typecheck` clean + `pnpm dev` boots + `node --test` green.

### Step 2.1 — Foundational leaves: `logger`, `config`
**What:** `logger.js → logger.ts`, `config.js → config.ts`. Type the exported
`config` object (a `Config` interface) and the logger. These are imported
nearly everywhere, so typing them first propagates types outward.
**Source:** `src/logger.js`, `src/config.js`.
**Target:** `src/logger.ts`, `src/config.ts`.
**Deleted:** the `.js` originals (replaced in place).
**Contract change:** none.
**Test:** standard Phase-2 test.
**Depends on:** 1.1.

### Step 2.2 — State leaves: `caches`, `identifiers`
**What:** `caches.js → caches.ts` (type the `Map`/`Set` singletons and
`cacheSetBounded`), then `identifiers.js → identifiers.ts` (type `normalizeJid`,
`nextContextMsgId`, `rememberSenderRef`, `rememberMessage`,
`resolveQuotedMessage`, the registry entry shapes, etc.). **Type-only here** —
do **not** change the module-singleton design yet (that is Step 3.3).
**Source:** `src/caches.js`, `src/identifiers.js`.
**Target:** `src/caches.ts`, `src/identifiers.ts`.
**Deleted:** the `.js` originals.
**Contract change:** none.
**Test:** standard; plus any existing identifier unit tests.
**Depends on:** 2.1.

### Step 2.3 — Parsing/media leaves: `messageParser`, `participants`, `mediaHandler`, `groupContext`
**What:** Convert these four. They depend on `logger`/`config`/`caches` only.
Type `unwrapMessage`, `extractText`, `extractQuoted`, `saveMedia`,
`resolveAllowedAttachmentPath`, group metadata shapes, role flags.
**Source:** `src/messageParser.js`, `src/participants.js`, `src/mediaHandler.js`,
`src/groupContext.js`.
**Target:** the `.ts` equivalents.
**Deleted:** the `.js` originals.
**Contract change:** none.
**Test:** standard.
**Depends on:** 2.2.

### Step 2.4 — `db.ts`
**What:** `db.js → db.ts` (47 KB, mostly self-contained over `better-sqlite3`).
Type the row shapes (`chat_settings`, `llm_models`, `chat_activations`, etc.
from doc 05) and the exported CRUD functions. No schema or query changes.
**Source:** `src/db.js`.
**Target:** `src/db.ts`.
**Deleted:** `src/db.js`.
**Contract change:** none (same SQLite schema/behavior).
**Test:** standard; plus `pnpm stress:db` still passes.
**Depends on:** 2.1.

### Step 2.5 — Protocol types module: `protocol/types.ts`
**What:** New file defining TypeScript types for **every** WS message shape, in
both directions: `IncomingMessagePayload` (the full inbound shape from doc 04 /
README), each action payload (`SendMessagePayload`, `ReactMessagePayload`, …),
`ActionAck`, `SendAck`, `WsError`, and the control events. This is a leaf
(types only) and becomes the single source of truth consumed by `wa/*`,
`eventForwarder`, `actionDispatcher`, and `wsServer`. Add the new handshake
types (`HelloPayload { folderPath, protocolVersion }`, `HelloAckPayload
{ folderPath, waStatus }`) now so later phases import them.
**Source:** doc `04-protocol-and-actions.md`, `README.md` protocol section,
existing `inbound.js` payload literal (~`const payload = { ... }`).
**Target:** `src/protocol/types.ts` (new).
**Deleted:** none.
**Contract change:** none yet (types describe the existing wire format; the
`folderPath`/handshake additions are not emitted until Phase 3).
**Test:** `pnpm typecheck` clean.
**Depends on:** 2.1.

### Step 2.6 — `wa/` leaves: `utils`, `sendQueue`, `interactive/*`
**What:** Convert `wa/utils.js`, `wa/sendQueue.js`, and
`wa/interactive/{sendInteractive,sendButtons,sendCarousel,index}.js`. These are
leaves relative to the rest of `wa/`. Keep `withJidQueue` signature (per-account
keying comes in Step 3.3).
**Source:** `src/wa/utils.js`, `src/wa/sendQueue.js`, `src/wa/interactive/*.js`.
**Target:** the `.ts` equivalents.
**Deleted:** the `.js` originals.
**Contract change:** none.
**Test:** standard.
**Depends on:** 2.1, 2.5.

### Step 2.7 — `wa/command/*` (parser first, then handlers, then barrel)
**What:** Convert `wa/command/parseCommand.js` first (typed
`parseSlashCommand`), then the ~28 handler files (`prompt`, `reset`,
`broadcast`, `model`, `modelcfg`, `setting`, `sticker`, `addsticker`, …), then
`wa/command/index.js` barrel. Handlers may be converted in sub-batches across
several commits — all leaf-equivalent since they depend on `db`/`config`/
identifiers, already typed. Logic unchanged; these stay in Node.
**Source:** `src/wa/command/*.js`.
**Target:** `src/wa/command/*.ts`.
**Deleted:** the `.js` originals.
**Contract change:** none.
**Test:** standard; manually exercise a couple of commands (`/help`, `/mode`)
in `pnpm dev`.
**Depends on:** 2.4, 2.5.

### Step 2.8 — `wa/` consumers: `actions`, `moderation`, `presence`, `runCommand`, `outbound`, `events`, `inbound`
**What:** Convert the action/event modules. These call identifiers + Baileys +
`wsClient.send`. **Type-only**; keep `wsClient.send` usage as-is (the direction
flip and `folderPath` stamping happen in Phase 3). Type `sendOutgoing`'s
return (`{ sent: SentEntry[], replyTo }`) against `protocol/types.ts`.
**Source:** `src/wa/{actions,moderation,presence,runCommand,outbound,events,inbound}.js`.
**Target:** the `.ts` equivalents.
**Deleted:** the `.js` originals.
**Contract change:** none.
**Test:** standard; `pnpm dev` round-trips an inbound message + a `send_message`
action against the existing Python server.
**Depends on:** 2.3, 2.6, 2.7.

### Step 2.9 — Orchestrators: `wa/commandHandler`, `wa/connection`, `wa/index`
**What:** Convert `commandHandler.js` (the big `switch`), `connection.js`
(`startWhatsApp`, button/form handlers, the two `messages.upsert` listeners),
and the `wa/index.js` barrel. Logic unchanged; still a single global `sock`.
**Source:** `src/wa/commandHandler.js`, `src/wa/connection.js`, `src/wa/index.js`.
**Target:** the `.ts` equivalents.
**Deleted:** the `.js` originals.
**Contract change:** none.
**Test:** standard; QR pairing + an inbound/outbound round trip in `pnpm dev`.
**Depends on:** 2.8.

### Step 2.10 — `wsClient.ts` and `index.ts`
**What:** Convert `wsClient.js → wsClient.ts` (type `LLMWebSocket`,
`computeReconnectDelay`, queues) and `index.js → index.ts` (type
`dispatchCommand`, `emitActionAck`/`emitActionError`, `bootstrap`). The entry
point is now `.ts`. This completes the JS→TS migration with topology
**unchanged** (Node still a WS client; Python still server).
**Source:** `src/wsClient.js`, `src/index.js`.
**Target:** `src/wsClient.ts`, `src/index.ts`.
**Deleted:** the `.js` originals.
**Contract change:** none.
**Test:** full `pnpm dev` smoke test against the existing Python server;
`tests/node/**` (incl. `computeReconnectDelay` tests) green; `pnpm typecheck`
clean with `allowJs` now effectively unused.
**Depends on:** 2.9.

> After Phase 2 the whole `src/` is TypeScript and behaves identically. The WS
> direction has **not** flipped yet.

---

## Phase 3 — Multi-account + WS Server (Node)

All new modules are built in TypeScript and **unit-tested behind a secondary
entry/flag**. The live boot path (`index.ts` → `wsClient` + single
`startWhatsApp`) stays active so the system remains runnable. The actual
cutover to the server is Phase 5.

### Step 3.1 — `accountRegistry.ts`
**What:** New leaf module: `Map<folderPath, AccountEntry>` where `AccountEntry =
{ folderPath, sock?: WASocket, client?: WebSocket, ctx: AccountContext,
reliableQueue: WsMessage[], waStatus }`. CRUD: `getOrCreate(folderPath)`,
`get`, `bindClient`, `unbindClient`, `bindSock`, `list`, `remove`. Holds the
per-account reliable-event queue (mirror of `wsClient.reliableQueue`, now
server-side, flushed when that account's client (re)connects).
**Source:** new; conceptually mirrors the singleton role `getSock()` played in
`connection.ts`.
**Target:** `src/server/accountRegistry.ts` (new).
**Deleted:** none.
**Contract change:** none (not wired into boot yet).
**Test:** unit tests for registry CRUD + reliable-queue overflow (bound 1000,
oldest dropped — same as `LLMWebSocket.MAX_RELIABLE_QUEUE`).
**Depends on:** 2.5.

### Step 3.2 — `AccountContext` + per-account state isolation (D2)
**What:** Implement decision **D2**. Define `AccountContext` owning the
`Map`/`Set` instances currently module-global in `caches.ts`, the contextMsgId
counter + senderRef registries from `identifiers.ts`, and a per-account
JID send-queue. Refactor `caches`, `identifiers`, `sendQueue`, `outbound`,
`inbound`, `events`, and `interactive/*` so the cache/identifier/queue
functions take (or are bound to) an `AccountContext` instead of importing
module singletons. Provide a factory `createAccountContext(folderPath)`.
**This is the largest refactor** — do it as its own step; it must merge as one
unit because every identifier/cache call site changes signature together.
**Source:** `src/caches.ts`, `src/identifiers.ts`, `src/wa/sendQueue.ts`,
`src/wa/outbound.ts`, `src/wa/inbound.ts`, `src/wa/events.ts`,
`src/wa/interactive/*.ts`.
**Target:** `src/account/accountContext.ts` (new) + edits to the above.
**Deleted:** the module-global singletons in `caches.ts` (moved into context).
**Contract change:** none on the wire; internal API change only.
**Test:** new unit test proving two `AccountContext`s with the **same `chatId`**
keep independent contextMsgId counters and senderRef registries (the core
multi-account correctness property). Existing identifier tests adapted to pass a
context. `pnpm typecheck` clean.
**Depends on:** 3.1; supersedes the singleton assumptions from 2.2/2.6/2.8.
**Note:** must merge atomically with the call-site edits in the listed `wa/`
modules (single PR).

### Step 3.3 — `baileysFactory.ts`
**What:** Generalize `startWhatsApp` into
`createOrResumeAccount(folderPath): Promise<AccountEntry>`: derive the
per-folder auth dir (`<folderPath>/auth`), call `useCachedAuthState` on it,
`makeWASocket`, create the `AccountContext`, register the socket in
`accountRegistry`, and wire `creds.update`, `connection.update`,
`groups.update`, `group-participants.update`, and the two `messages.upsert`
listeners — all bound to this account's context (no global `sock`). Idempotent:
if the folder already has a live socket, return it.
**Source:** `src/wa/connection.ts` `startWhatsApp` (the whole function),
`config.authDir` usage.
**Target:** `src/account/baileysFactory.ts` (new); `connection.ts` reduced to
shared helpers (QR print, button/form handlers parameterized by account).
**Deleted:** the global `let sock` / `getSock()` singleton (replaced by
registry lookup) — but keep a thin `getSock()` shim during Phase 3 so the still
active old boot path keeps working until Phase 5.
**Contract change:** none on the wire.
**Test:** unit test creating two accounts with different folder paths produces
two independent auth dirs and two registry entries; QR flow still works for one
account in a manual run.
**Depends on:** 3.1, 3.2.

### Step 3.4 — `eventForwarder.ts`
**What:** Move the "Listener 2 (chatbot handler)" path: Baileys `messages.upsert`
→ `inbound.ts handleIncomingMessage` (now context-bound) → produce
`IncomingMessagePayload` with `folderPath` stamped in → send to **that
account's client** via the registry (best-effort `send`, mirroring the old
`wsClient.send`). Group-join/role-change synthetic events
(`events.ts`) routed the same way. Replaces the direct `wsClient.send` calls in
`inbound.ts`/`events.ts` with `registry.sendToClient(folderPath, frame)`.
**Source:** `src/wa/inbound.ts` (`wsClient.send({ type: 'incoming_message' })`),
`src/wa/events.ts` (the three `wsClient.send` emitters), `connection.ts`
Listener 2.
**Target:** `src/account/eventForwarder.ts` (new); edits to `inbound.ts`/
`events.ts` to emit via the injected forwarder.
**Deleted:** none.
**Contract change:** **additive** — every Node→Python event payload now carries
`folderPath`. (Backwards-compatible: the existing Python server would ignore it;
relevant only post-flip.)
**Test:** unit test: a fake Baileys upsert for account A is delivered only to
A's client and includes `folderPath`. 
**Depends on:** 3.2, 3.3.

### Step 3.5 — `actionDispatcher.ts`
**What:** Move `dispatchCommand` + `emitActionAck`/`emitActionError`
(`index.ts`) here, parameterized by `AccountEntry`. Inbound action frame +
`folderPath` → resolve account's `sock`/`ctx` → existing `wa/` handler
(`sendOutgoing` via the account's `withJidQueue`, `reactToMessage`,
`deleteMessageByContextId`, `kickMembers`, `markChatRead`, `sendPresence`,
`sendQuiz`, `sendCopyCode`, `sendLottieSticker`, `sendNativeFlow`,
`sendCarousel`, `dispatchRunCommand`) → `action_ack`/`send_ack`/`error` sent
back to **that** client. Behavior and result shapes identical to today
(doc 04 "action_ack result formats").
**Source:** `src/index.ts` `dispatchCommand` (~the `if (type === ...)` chain),
`emitActionAck`, `emitActionError`, `deriveKickFailure`.
**Target:** `src/account/actionDispatcher.ts` (new).
**Deleted:** none yet (the copy in `index.ts` is removed at the flip, Step 5.1).
**Contract change:** none to the action/ack wire shapes.
**Test:** unit test: a `send_message` frame for account A routes to A's socket
and returns an `action_ack` (+ `send_ack`) with the `{ sent, replyTo }` result;
a `kick_member` failure maps to the right `code`.
**Depends on:** 3.2, 3.3.

### Step 3.6 — `wsServer.ts`
**What:** New WS **server** (`ws.Server`) on `WS_LISTEN_PORT` (default 3000).
On client connect: read `hello { folderPath, protocolVersion }` →
`baileysFactory.createOrResumeAccount(folderPath)` →
`registry.bindClient(folderPath, client)` → reply `hello_ack { folderPath,
waStatus }` → flush that account's reliable queue. Route inbound frames to
`actionDispatcher`; route Baileys events out via `eventForwarder`. On client
disconnect: `unbindClient` (keep the Baileys socket alive so the account stays
connected to WhatsApp; queue reliable control events until the client returns).
Server-side heartbeat using the canonical `ws` `isAlive` ping/terminate pattern
(ported from `wsClient.ts` `_startHeartbeat`). Optional bearer-token check
mirroring `LLM_WS_TOKEN`.
**Source:** new; protocol from doc 04 + the handshake spec; heartbeat from
`src/wsClient.ts` `_startHeartbeat`/`_clearHeartbeat`.
**Target:** `src/server/wsServer.ts` (new).
**Deleted:** none.
**Contract change:** introduces the new server-side protocol (handshake
`hello`/`hello_ack`, `folderPath`-tagged events). Not on the live path yet.
**Test:** integration test with a scripted raw WS client: connect → `hello` →
receive `hello_ack`; send a `send_message` action → receive `action_ack`;
disconnect mid-flight → reliable control event queued → reconnect → queued event
delivered.
**Depends on:** 3.4, 3.5.

### Step 3.7 — Route control events through the registry
**What:** Slash-command handlers and `connection.ts` currently call
`wsClient.sendReliable({ type: 'clear_history' | 'set_llm2_model' |
'invalidate_*' | 'set_subagent_enabled' | 'whatsapp_status' })`. Reroute these
to the **account's** client via `registry.sendReliableToClient(folderPath, …)`
so the right Python client receives them; queue when that client is offline.
**This requires the command/connection layer to know which `folderPath` it is
acting for** — thread the `folderPath`/`AccountContext` into `handleCommandListener`
and the button handlers (they already receive `chatId`; now also the account).
**Source:** every `wsClient.sendReliable(...)` call site:
`src/wa/connection.ts` (model select, modelcfg remove, `whatsapp_status`),
`src/wa/command/*.ts` handlers that invalidate settings/models.
**Target:** those call sites + `accountRegistry` reliable-send API.
**Deleted:** none.
**Contract change:** control events become per-account (carry/imply
`folderPath`); shapes otherwise unchanged.
**Test:** unit test: `/model` on account A's chat enqueues
`set_llm2_model`/`invalidate_llm2_model` only to A's client.
**Depends on:** 3.1, 3.6.

> After Phase 3, Node can run as a multi-account server **in tests**, but the
> production boot in `index.ts` is still the old single-account client path.

---

## Phase 4 — `wasocket/` Package (Python, not yet wired)

Pure SDK. Knows nothing about the agent/LLM/DB. Built and tested in isolation
against the Step 3.6 `wsServer` (or a stub). The agent still runs on the old
server (`main.py`) throughout Phase 4.

### Step 4.1 — `wasocket/errors.py`
**What:** `WaSocketError` base + subclasses mapping the stable error codes
(`NotFoundError`, `NotGroupError`, `PermissionDeniedError`,
`InvalidTargetError`, `SendFailedError`, `TimeoutError`) from an `error` frame's
`code`. A `from_error_frame(payload)` constructor.
**Source:** doc 04 "Stable error codes"; Node `actionErrorCode` in `index.ts`.
**Target:** `python/wasocket/errors.py` (new).
**Deleted:** none.
**Contract change:** none.
**Test:** unit: each code maps to the right class; unknown code → base error.
**Depends on:** none.

### Step 4.2 — `wasocket/protocol.py`
**What:** Frozen dataclasses for frames: `Action`, `Event`, `Ack`, plus
`encode(frame) -> str` / `decode(str) -> frame` and the handshake `Hello`/
`HelloAck`. Mirrors `protocol/types.ts` (Step 2.5) field-for-field so the two
sides cannot drift.
**Source:** `src/protocol/types.ts`; README payload shapes.
**Target:** `python/wasocket/protocol.py` (new).
**Deleted:** none.
**Contract change:** none (describes existing + handshake shapes).
**Test:** round-trip encode/decode; a golden sample of each action/event JSON
decodes without loss.
**Depends on:** 4.1.

### Step 4.3 — `wasocket/events.py`
**What:** Event-name constants (`MESSAGE="message"`, `STATUS="status"`,
`READY="ready"`, `ERROR="error"`, plus the control-event names
`CLEAR_HISTORY`, `SET_LLM2_MODEL`, `INVALIDATE_LLM2_MODEL`,
`INVALIDATE_DEFAULT_MODEL`, `INVALIDATE_CHAT_SETTINGS`, `SET_SUBAGENT_ENABLED`).
Define the SDK's `WhatsAppMessage` dataclass = the **inbound `incoming_message`
payload** shape (`chatId`, `senderRef`, `text`, `quoted`, `attachments`, …).
**Explicitly NOT** `bridge.history.WhatsAppMessage` (the agent's internal
history representation) — name-collision is intentional in the plan text but
these are different types; keep them in different modules and do not import one
as the other.
**Source:** doc 04 incoming_message table; `src/wa/inbound.ts` payload literal;
contrast with `python/bridge/history.py` `WhatsAppMessage`.
**Target:** `python/wasocket/events.py` (new).
**Deleted:** none.
**Contract change:** none.
**Test:** unit: an `incoming_message` payload parses into the SDK
`WhatsAppMessage` with all fields populated.
**Depends on:** 4.2.

### Step 4.4 — `wasocket/correlation.py`
**What:** `requestId` generation — **port the exact format** from
`processing.py::_make_request_id` (`f"{action}-{int(time.time()*1000)}-{next(counter):06d}"`)
so logs/correlation match. A `PendingAcks` dict mapping `requestId → asyncio.Future`
with `register`, `resolve(ack)`, `reject(error)`, and per-request timeout.
**Source:** `python/bridge/messaging/processing.py` `_make_request_id`,
`REQUEST_COUNTER`.
**Target:** `python/wasocket/correlation.py` (new).
**Deleted:** none (the bridge keeps its own `_make_request_id` until Phase 5
delegates to the SDK).
**Contract change:** none.
**Test:** unit: register → resolve resolves the future with the result;
timeout rejects with `TimeoutError`; duplicate/late acks are ignored.
**Depends on:** 4.1.

### Step 4.5 — `wasocket/transport.py` (ports `wsClient.js` reconnect/backoff)
**What:** `WSClientTransport`: the WS **client** with connect / reconnect /
exponential backoff + symmetric jitter / heartbeat / reliable queue / graceful
close. **This is the step that ports `src/wsClient.js`
(`computeReconnectDelay`, the `isAlive` heartbeat with single-interval
ping/terminate, the `stableResetTimer` grace period before resetting the
attempt counter, the bounded reliable queue, async `close()`) into Python.**
Handles the `hello`/`hello_ack` handshake on (re)connect (re-sends `folderPath`,
re-flushes the reliable queue). Emits raw decoded frames to a callback; does not
interpret them (that is `socket.py`).
**Source:** `src/wsClient.js` (entire file: `computeReconnectDelay`,
`LLMWebSocket.connect/scheduleReconnect/_startHeartbeat/_clearHeartbeat/close/
send/sendReliable/flushReliableQueue`).
**Target:** `python/wasocket/transport.py` (new).
**Deleted:** none yet (Node `wsClient.ts` is deleted post-flip in Step 5.3).
**Contract change:** none.
**Test:** port the `computeReconnectDelay` unit tests to Python (same inputs →
same delays, with injectable RNG); a fake server that accepts-then-kicks proves
backoff keeps growing (grace-timer behavior); reliable queue flushes on
reconnect.
**Depends on:** 4.2, 4.4.

### Step 4.6 — `wasocket/socket.py` + `__init__.py`
**What:** `WaSocket`: public API per the spec — `make_wa_socket(folder_path)`,
`connect(node_url="ws://localhost:3000")`, `disconnect`, `is_connected`,
`folder_path`; `on(event)` decorator dispatch; action methods (`send_message`,
`send_quiz`, `react`, `delete_message`, `kick`, `send_presence`, `mark_read`,
`send_buttons`, `send_carousel`, `send_copy_code`, `send_sticker`). Each action
method builds a frame via `protocol.py`, allocates a `requestId` via
`correlation.py`, sends through `transport.py`, and (per **D3**) awaits the ack
future → returns the `result` (or raises `WaSocketError`); `mark_read`/
`send_presence` send without awaiting. Incoming frames are dispatched to
event handlers: `incoming_message → "message"` (as SDK `WhatsAppMessage`),
`whatsapp_status → "status"`, `hello_ack → "ready"`, `error → "error"` +
future rejection, `action_ack`/`send_ack` → resolve futures **and** re-emit as
events (D3 option b), control events (`clear_history`, etc.) → emitted by their
type name. `__init__.py` exports `make_wa_socket`, `WaSocket`, `WhatsAppMessage`.
**Source:** `python/bridge/messaging/gateway.py` (the send_* frame shapes are
the canonical action payloads to mirror); spec interface block.
**Target:** `python/wasocket/socket.py`, `python/wasocket/__init__.py` (new).
**Deleted:** none.
**Contract change:** none (SDK speaks the existing action wire format + the new
handshake).
**Test:** integration against the Step 3.6 `wsServer` (or a stub): `connect` →
`ready`; `await send_message(...)` returns `{ sent: [...], replyTo }`;
`delete_message` to a bad id raises `NotFoundError`; an emitted `incoming_message`
fires the `@on("message")` handler with the right `folderPath`; a `clear_history`
control event fires its handler.
**Depends on:** 4.3, 4.5.

---

## Phase 5 — Wire Agent to WaSocket (the cutover)

### Step 5.1 — WS Direction Flip (atomic cutover)
**What:** The one explicitly-named direction flip. Two coordinated changes that
**must ship together**:

- **Node:** change the production boot in `index.ts` from
  `startWhatsApp()` (single global sock) + `wsClient.connect()` to
  `wsServer.listen(WS_LISTEN_PORT)`. Remove the `dispatchCommand` body from
  `index.ts` (now lives in `actionDispatcher`, Step 3.5); `index.ts` becomes the
  thin entrypoint (start server + `dbInit` + signal handling). Accounts are
  created lazily when Python clients connect (Step 3.6).
- **Python:** rewrite `main.py`'s transport seam. Replace `websockets.serve(
  handle_socket, ...)` + the `async for raw in ws` event loop with a `WaSocket`
  client. The body of `handle_socket` (all per-chat agent state + the
  debounce/batch pipeline + `process_message_batch`) is preserved but moved
  behind `@sock.on("message")`. Refactor `gateway.py` send_* helpers to call
  the `sock` action methods instead of `ws.send(json.dumps(...))` (the `ws`
  first-arg becomes the `WaSocket`). Subscribe control-event handlers
  (`@sock.on("clear_history")`, `set_llm2_model`, `invalidate_*`,
  `set_subagent_enabled`, `whatsapp_status` → the existing handler bodies from
  the old loop).

**What makes it safe:** the new server (Phase 3) and SDK (Phase 4) were each
built and tested against the *other side's* contract before this step, so the
protocol is already proven end-to-end in tests. The action/ack/event wire
shapes are unchanged except the additive `folderPath`. A staging environment can
run the new Node server + one WaSocket client and replay a recorded message set
for parity against the old stack before promoting. Rollback = revert the two
boot wirings (Node back to `wsClient`+`startWhatsApp`, Python back to
`websockets.serve`); nothing else in `wa/` or `bridge/` logic changed.

**What could break during the flip:**
- **In-flight loss:** messages/actions mid-transit during the swap are dropped
  (no shared persistent queue across the topology change). Mitigate by draining
  / quiet window during deploy.
- **Reconnect storms:** if many accounts connect at once, Node creates many
  Baileys sockets simultaneously — stagger or rate-limit `createOrResumeAccount`.
- **Auth path mapping:** old single `data/auth` must be mapped to the correct
  `folderPath`/auth for the first account, or it will print a fresh QR.
- **Ack-timing / provisional history:** see Step 5.2 — the await-vs-event choice
  changes when `contextMsgId` becomes known.
- **Control-event delivery:** if a Python client is briefly disconnected, the
  per-account reliable queue (Step 3.1/3.7) must hold `clear_history` etc.;
  a bug there silently drops settings invalidations (the classic "settings don't
  take effect until restart" symptom).

**Source:** `src/index.ts` (`bootstrap`, `dispatchCommand`), `python/bridge/main.py`
(`handle_socket`, `main`, the `async for raw in ws` loop, control-event
branches), `python/bridge/messaging/gateway.py` (all send_* signatures).
**Target:** `src/index.ts` (thin entry), `python/bridge/main.py`,
`python/bridge/messaging/gateway.py`.
**Deleted:** `handle_socket`'s WS-server scaffolding + `websockets.serve` in
`main.py`; the `dispatchCommand` body in `index.ts`.
**Contract change:** **the direction flip itself** — Python is now the client,
Node the server; handshake `hello`/`hello_ack`; `folderPath` on every event.
**Test:** end-to-end on staging: pair one account, inbound message → LLM1/LLM2 →
`send_message` → WhatsApp; `/reset` (`clear_history`), `/model`
(`set_llm2_model`), mute enforcement, a quiz round-trip, and a sub-agent task
all behave as before. `tests/node/**` + SDK tests green.
**Depends on:** 3.6, 3.7, 4.6.
**Note:** **must merge atomically** — the Node boot change and Python `main.py`
change cannot land separately without breaking the running system.

### Step 5.2 — Reconcile provisional-history hydration (D3)
**What:** Apply decision **D3**. For `send_message` and sub-agent attachment
sends, keep the existing hydration path working by subscribing to the SDK's
re-emitted `action_ack` event (option **b**): the handler bodies that today live
in the `event_type in {"send_ack","action_ack"}` branch of the old loop
(`_hydrate_provisional_context_id_from_ack`, `pending_send_request_chat`,
`pending_subagent_attachments`, `pending_run_command_chat`) move into
`@sock.on("action_ack")` handlers essentially verbatim. Where convenient for
new/simple call sites, use the awaited return value (option **a**) instead.
This may be folded into Step 5.1's PR but is listed separately because it is the
single most behavior-sensitive part of the cutover.
**Source:** `python/bridge/main.py` action_ack/send_ack handling block;
`processing.py` `_hydrate_provisional_context_id_from_ack`,
`_extract_send_ack_context_msg_id`, `_extract_all_send_ack_entries`.
**Target:** `python/bridge/main.py` (new `@sock.on("action_ack")` handlers).
**Contract change:** none on the wire (SDK re-emits acks as events by design).
**Test:** provisional history entry (`context_msg_id="pending"`,
`message_id="local-send-<rid>"`) is hydrated to the real 6-digit id after the
ack event; sub-agent attachment paths land in `media_paths_by_chat`;
`run_command` ack appends the synthetic "Command X executed" history line.
**Depends on:** 5.1.
**Note:** must merge atomically with 5.1 (the old loop that did this is removed
there).

### Step 5.3 — Delete Node `wsClient.ts`
**What:** With the server live and stable, the Node WS **client** is unused.
Remove `src/wsClient.ts` and the thin `getSock()` shim left in Step 3.3. Move
the `computeReconnectDelay` unit tests' intent to the Python `transport.py`
tests (already added in Step 4.5).
**Source:** `src/wsClient.ts`; residual `wsClient` imports.
**Target:** delete file; clean imports.
**Deleted:** `src/wsClient.ts`.
**Contract change:** none.
**Test:** `pnpm typecheck` clean (no dangling imports); `pnpm dev` boots the
server; `tests/node/**` green.
**Depends on:** 5.1.

### Step 5.4 — Trim Python server dependency surface
**What:** `main.py` no longer runs `websockets.serve`; the only remaining use of
`websockets` is the SDK transport client (Step 4.5). Confirm `requirements.txt`
still needs `websockets` (it does, for the client) and remove any
server-only imports/`_parse_endpoint`/`_shutdown_signal_handler` left dead in
`main.py`.
**Source:** `python/bridge/main.py` (`_parse_endpoint`, legacy
`_shutdown_signal_handler`, `websockets.serve` import path).
**Target:** `python/bridge/main.py`, `requirements.txt` (verify only).
**Deleted:** dead server helpers in `main.py`.
**Contract change:** none.
**Test:** bridge boots as a client and connects to the Node server; no unused
imports (`python -m pyflakes`/lint clean if configured).
**Depends on:** 5.1.

---

## Phase 6 — Multi-account Boot

### Step 6.1 — Per-account agent instantiation (Python)
**What:** The per-chat agent state in `main.py` (the `per_chat`,
`per_chat_lock`, `pending_by_chat`, `media_paths_by_chat`, sub-agent tracker,
dedup signatures, idle counters) is currently created once inside
`handle_socket`. Refactor it into an `AgentSession` constructed **per
`WaSocket`** so each account has isolated state. `make_wa_socket(folder_path)` +
register an `AgentSession`'s handlers on it.
**Source:** `python/bridge/main.py` `handle_socket` local-state block + the
`process_message_batch`/`flush_pending` closures.
**Target:** `python/bridge/main.py` (extract `AgentSession`), or a new
`python/bridge/session.py`.
**Contract change:** none.
**Test:** two `AgentSession`s over two `WaSocket`s keep independent history /
debounce / sub-agent state; a message on account A never appears in account B's
history.
**Depends on:** 5.1, 5.2.

### Step 6.2 — Multi-account entrypoint (Python) + lazy accounts (Node)
**What:** Bridge entrypoint reads an accounts config (env or a small
`accounts.json`: list of `folder_path`s) and instantiates N `WaSocket` +
`AgentSession` pairs, all connecting to the one Node `node_url`. Node side
already creates/resumes a Baileys socket per `folderPath` on connect
(Step 3.6) — verify per-folder auth dirs and confirm no global single-socket
assumptions remain (`getSock()` fully gone).
**Source:** `python/bridge/main.py` `main()`; `src/server/wsServer.ts`,
`src/account/baileysFactory.ts`.
**Target:** `python/bridge/main.py` (N-socket boot), config loader (new).
**Contract change:** none beyond what Phase 3/5 introduced.
**Test:** boot with two `folder_path`s → two QR pairings (or two resumed
sessions) → messages to each account handled independently and concurrently.
**Depends on:** 6.1.

### Step 6.3 — Docs, env, and end-to-end
**What:** Update `AGENTS.md`/`README.md` for the reversed topology, the
`WS_LISTEN_PORT`/`node_url` config, per-folder auth layout, and the
`make_wa_socket` usage. Add `.env`/config keys; deprecate
`LLM_WS_ENDPOINT` (server now) in favor of the listen port + per-client
`node_url`. Add a two-account e2e smoke test.
**Source:** `AGENTS.md`, `README.md`, `.env.example`.
**Target:** docs + config.
**Contract change:** documentation of the new protocol/handshake/`folderPath`.
**Test:** docs match the running system; two-account e2e passes; fresh-clone
setup following the README boots both stacks.
**Depends on:** 6.2.

---

## Quick reference — special requirements from the brief

- **WS direction flip** → **Step 5.1** (single named step; atomic Node-boot +
  Python-`main.py` change; safety + breakage analysis inline there).
- **`wsClient.js` reconnect/backoff → `wasocket/transport.py`** → **Step 4.5**
  (port `computeReconnectDelay`, heartbeat, grace timer, reliable queue). The
  Node `wsClient.ts` is deleted later in **Step 5.3**.
- **`commands.py` removal** → **Step 0.1**.
- **Largest multi-account refactor (per-account state)** → **Step 3.2** (must
  merge atomically with its `wa/` call-site edits).
- **Provisional-history / ack-correlation reconciliation** → **D3** + **Step
  5.2** (must merge atomically with 5.1).
