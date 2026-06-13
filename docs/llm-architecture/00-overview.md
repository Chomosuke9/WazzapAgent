# 00 - System Overview

> **Source of truth:** `AGENTS.md` (architecture, ADRs, conventions) and
> `CONTRACT.md` (wire protocol §1, `make_wa_socket` SDK §4, per-tenant folder
> layout §8). This document is an orientation guide; if it ever disagrees with
> those, they win.

## Topology (reversed, post-migration)

The **Node.js gateway is the WebSocket _server_** (TypeScript, `src/`). It binds
`WS_BIND_HOST:WS_LISTEN_PORT` (default `127.0.0.1:3000`) and accepts connections.
Each **Python `WaSocket` is a _client_** that **dials** the gateway at `NODE_URL`,
announces its tenant `folder_path` in a `hello`/`hello_ack` handshake
(CONTRACT.md §1.1), and then drives one WhatsApp account.

```
 phone A          phone B           ← one WhatsApp account per tenant
    ↕                ↕                 (Baileys v7 socket, per-tenant auth)
┌───────────────────────────────────────────────┐
│ Node gateway — WS SERVER (src/, TypeScript)     │
│  server/   wsServer.ts, accountRegistry.ts      │
│  account/  baileysFactory, accountContext,      │
│            actionDispatcher, eventForwarder     │
│  db/       Database + repositories (per tenant) │
│  wa/       inbound/outbound/actions/commands    │
└───────────────────────────────────────────────┘
   ▲ hello / hello_ack (§1.1)        ▲
   │ incoming_message, whatsapp_status, control   │ actions (Py→Node):
   │ events, acks (Node→Python)                   │ send_message, react, …
 dial│ NODE_URL                               dial│ NODE_URL
┌────┴──────────────┐                  ┌───────────┴───────┐
│ Python WaSocket A  │                  │ Python WaSocket B  │
│ folder=tenants/a   │                  │ folder=tenants/b   │
│ AgentSession (root)│                  │ AgentSession (root)│
└────────────────────┘                  └────────────────────┘
```

A single Python process can run **several tenants** (the bridge loads an
accounts list via `bridge/accounts.py` and runs one `WaSocket` + `AgentSession`
per `folder_path`, gathered concurrently). A single account is the degenerate
case. Every tenant is fully isolated under `<folder_path>/{auth,db,media,stickers}`
(CONTRACT.md §8): per-tenant Baileys auth, per-tenant SQLite DBs, per-tenant
media/sticker dirs, and a per-account state holder (`AccountContext`) — no
process-global socket/DB/cache is shared across accounts.

## Core components

### 1) Node gateway (`src/`, TypeScript)
- WhatsApp connection via Baileys v7 (`account/baileysFactory.ts`), one socket
  per tenant, created/resumed lazily on the tenant's first `hello`.
- WS server (`server/wsServer.ts`): accept clients, Bearer-token auth at the
  upgrade (`LLM_WS_TOKEN`), per-connection `isAlive` heartbeat, route inbound
  action frames to the per-account dispatcher.
- Account registry (`server/accountRegistry.ts`): bind each client to its
  `folder_path` `AccountEntry`; best-effort vs reliable (queued) delivery.
- Incoming message parse + media normalization (`wa/domain/messageParser.ts`,
  `mediaHandler.ts`), assigning `contextMsgId` + `senderRef`
  (`wa/domain/identifiers.ts`).
- Slash command handling (`wa/commands/CommandRegistry.ts` + per-command modules
  in `wa/command/`).
- Action execution received from Python (`account/actionDispatcher.ts` →
  `wa/*`): `send_message`, `delete_message`, `kick_member`, `run_command`, …
- Per-tenant SQLite via `db/Database.ts` (owns one tenant's settings/stats/
  moderation/subagent DBs; no module-global handles).

### 2) Python bridge (`python/bridge/`)
- `WaSocket` SDK (`python/wasocket/`, CONTRACT.md §4): dials `NODE_URL`,
  performs the handshake, exposes typed action methods + an `on(event)`
  decorator, reconnects with backoff + an `isAlive` heartbeat.
- `AgentSession` (`bridge/session.py`): the per-account composition root that
  wires the injectable `bridge/agent/` collaborators (MuteGate, BatchProcessor,
  Llm1Router, Llm2Responder, SubAgentCoordinator, ReplyDedup, IdleTrigger,
  AckHydrator, EventRouter).
- Receives `incoming_message` events; batches/debounces per chat, trigger
  filtering, LLM1 routing, LLM2 response generation; extracts tool calls into
  actions and sends them back over the same connection.
- Per-tenant settings/moderation/stats via `bridge/db/` (ContextVar-scoped
  per-tenant connections + tenant-keyed caches).

### 3) Sub-agent system (`python/bridge/subagent/`)
Lets LLM2 delegate complex work to an external HTTP agent via `execute_subtask`.
`SubTaskTracker` tracks per-chat sessions (steering, dedup, cleanup); a
persistent webhook server (per `AgentSession`, bound to `SUBAGENT_WEBHOOK_HOST`,
default loopback, on `SUBAGENT_WEBHOOK_PORT + accountIndex`) receives
progress/completion callbacks and re-invokes LLM2 with the result. Supports one
correction re-dispatch.

### 4) Idle trigger
Probabilistic re-engagement (`bridge/agent/idle_trigger.py`): on
non-triggered / LLM1-skipped messages a per-chat counter increments; when it
reaches the configured range the bot responds anyway with
`P = 1 / (max - count + 1)`. Reset on each bot reply.

## Data flow (detailed)
1. User sends a message on WhatsApp.
2. Baileys emits `messages.upsert` on that tenant's socket (listeners attached
   by `account/baileysFactory.ts`).
3. Node unwraps the raw message (`wa/domain/messageParser.ts`).
4. Node assigns `contextMsgId` + `senderRef` (`wa/domain/identifiers.ts`) on the
   tenant's `AccountContext`.
5. Slash commands are dispatched/executed in Node first
   (`wa/commands/CommandRegistry.ts`); handled commands are not forwarded (the
   `incoming_message` carries `commandHandled: true`).
6. Node forwards a normalized `incoming_message` to that tenant's bound Python
   client (best-effort via the registry; dropped if the client is not OPEN).
7. The owning `AgentSession`'s MuteGate runs first — muted senders are deleted
   instantly without further processing.
8. BatchProcessor debounces per chat (skipped for private chats / prefix
   matches), then builds a burst.
9. Trigger filtering (prefix/hybrid/auto) gates the burst.
10. The idle trigger may promote an otherwise-skipped burst.
11. **LLM1** (router) decides respond / express-only / skip (skipped in DMs and
    when `LLM1_ENDPOINT` is empty).
12. **LLM2** (responder) produces text + tool calls.
13. Actions are extracted (`messaging/actions.py`).
14. Actions are sent to Node over the same WS connection
    (`messaging/gateway.py` → the `WaSocket` SDK).
15. Node's per-account `actionDispatcher` executes each action and replies with
    `action_ack` / `error` (and `send_ack` for `send_message`).
16. The bridge hydrates provisional history on `action_ack` (`pending` →
    real `contextMsgId`), updates the reply-dedup cache, and may re-invoke LLM2
    on a sub-agent result.

## WebSocket protocol & reliability (CONTRACT.md §1.6)
After `hello`/`hello_ack`, **actions** flow Python→Node and **events, control
events and acks** flow Node→Python over one long-lived connection. Every
Node→Python frame carries `folderPath` for tenant routing.

- **best-effort** — dropped if the peer socket is not OPEN. Used for
  `incoming_message`, acks, presence.
- **reliable** — queued in memory and flushed on reconnect. Used for `hello`,
  `whatsapp_status`, and the control events (`clear_history`, `set_llm2_model`,
  `invalidate_llm2_model`, `invalidate_default_model`, `invalidate_chat_settings`,
  `set_subagent_enabled`). Node queues these per account on the registry
  (`sendReliableToClient`) and flushes when that account's client reconnects;
  the `WaSocket` SDK queues its own reliable frames (`hello`) symmetrically.

**Heartbeat:** the Node server (`server/wsServer.ts`) runs the canonical `ws`
`isAlive` ping/terminate loop at `WS_HEARTBEAT_INTERVAL_MS`. The Python
transport (`wasocket/transport.py`) mirrors it with its own `isAlive` heartbeat,
connecting with the `websockets` library's `ping_interval=None` so the SDK's
check-then-ping / terminate-on-missed-pong loop is the single liveness source.
Reconnect tuning (`WS_RECONNECT_MS`, `WS_RECONNECT_MAX_MS`,
`WS_RECONNECT_JITTER_RATIO`, `WS_HEARTBEAT_INTERVAL_MS`) is honored on both
sides; on the Python side these are read by `bridge/config.ws_transport_options()`
and forwarded to `make_wa_socket`.

**Auth:** when `LLM_WS_TOKEN` is set, the Node server requires
`Authorization: Bearer <token>` on the upgrade (401 otherwise, constant-time
compared) and the Python client sends the same header automatically. Bind to a
non-loopback `WS_BIND_HOST` only together with a token.

## Command design
Slash commands are split across both sides:

- **Node-side** (most commands, `wa/commands/CommandRegistry.ts` +
  `wa/command/*`): `/help`, `/info`, `/debug`, `/join`, `/sticker`, `/broadcast`,
  `/mode`, `/trigger`, `/setting`, `/model`, `/modelcfg`, `/group-status`,
  `/catch`, `/dashboard`, `/permission`, … Aliases are declared on each handler
  (single source of truth; parsing in `wa/command/parseCommand.ts`).
- **Python-side** (commands that need full LLM state / PIL): `/reset`, `/dump`,
  and Python's PIL sticker path. After certain Node commands run, Node emits the
  matching control event (`clear_history`, `invalidate_chat_settings`,
  `invalidate_llm2_model`, `set_subagent_enabled`) so the bridge stays in sync.

The `run_command` action lets LLM2 execute a Node slash command silently (no
chat echo).

## Debounce, dedup, mute, roles, interactive
These domain behaviors are unchanged by the topology reversal:
- **Debounce** — private chats skip it; prefix/hybrid skip it on a prefix match;
  `INCOMING_DEBOUNCE_SECONDS` quiet window capped by `INCOMING_BURST_MAX_SECONDS`.
- **Reply dedup** (`BRIDGE_REPLY_DEDUP_WINDOW_MS` / `_MIN_CHARS`) and **echo
  merge** (`BRIDGE_ASSISTANT_ECHO_MERGE_WINDOW_MS`) suppress duplicate output and
  fold the bot's own echoed messages into provisional history.
- **Mute enforcement** runs before debounce (instant delete + first-violation
  notice); promotion to admin clears mutes.
- **Bot role change** (`botrolechange`) drives promote/demote notifications.
- **Interactive UI** (`/setting`, quizzes, carousels) uses NativeFlow via
  `relayMessage` + `additionalNodes` (mobile-only; ADR-1 in AGENTS.md). Quiz
  message IDs are tracked in the per-account `quizMessageIds` set.
