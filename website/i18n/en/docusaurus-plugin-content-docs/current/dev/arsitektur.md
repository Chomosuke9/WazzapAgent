---
sidebar_position: 1
---

# Architecture

> For full developer context, see [AGENTS.md](https://github.com/Chomosuke9/WazzapAgents/blob/main/AGENTS.md) and [docs/llm-architecture/](https://github.com/Chomosuke9/WazzapAgents/tree/main/docs/llm-architecture).

WazzapAgents consists of two runtime components that communicate over WebSocket:

```
WhatsApp <──Baileys──> Node.js Gateway <──WebSocket──> Python LLM Bridge <──HTTP──> LLM API
```

## Main Components

### 1. Node.js Gateway (`src/`)

The gateway is responsible for:

- **WhatsApp connection** — Uses Baileys v7 to connect to WhatsApp via multi-device protocol.
- **Message parsing** — Extracts text, media, mentions, quoted messages, locations, and vCards from raw Baileys messages.
- **Forwarding to bridge** — Sends `incoming_message` payloads to the Python bridge via WebSocket.
- **Action execution** — Receives commands from the bridge (send, react, delete, kick, mark read, typing) and executes them on WhatsApp.
- **Interactive messages** — Sends interactive messages (buttons, carousels, lists) via `relayMessage` + `additionalNodes`.
- **Caching** — Stores message cache, group metadata (60s TTL), participant names, and sender ref registry in memory.

### 2. Python LLM Bridge (`python/bridge/`)

The bridge is responsible for:

- **WebSocket client** — Each `WaSocket` dials the Node gateway (server) at `NODE_URL`, sends a `hello` with its tenant `folderPath`, then receives events and sends actions back.
- **Message batching** — Groups incoming messages in burst windows with debounce logic.
- **Two-stage LLM pipeline:**
  - **LLM1 (Gating)** — Decides whether the bot should respond. Lightweight and fast.
  - **LLM2 (Responder)** — Generates complete responses with conversation context and system prompt.
- **Slash commands** — Handles `/prompt`, `/reset`, `/permission` directly.
- **Storage** — Five separate per-tenant SQLite databases under `<folder_path>/db`: `settings.db`, `stats.db`, `moderation.db`, `subagent.db`, `stickers.db`.
- **History management** — Stores conversation history per chat in memory with configurable limits.

## Data Flow

### Incoming Message (User → Bot)

```
1. User sends message on WhatsApp
2. Baileys receives `messages.upsert` event
3. Gateway parses message (wa/domain/messageParser.ts)
4. Gateway assigns contextMsgId & senderRef (wa/domain/identifiers.ts)
5. Gateway sends `incoming_message` to bridge via WebSocket
6. Bridge batches messages (5s debounce, 20s max burst)
7. Bridge runs LLM1 (gating decision)
8. If LLM1 decides to respond → run LLM2
9. LLM2 generates response + tool calls
10. Bridge parses actions from LLM2 tool calls
11. Bridge sends commands to gateway via WebSocket
12. Gateway executes actions on WhatsApp, sends ack/error back
```

### Context Messages (Bot → Bridge)

Messages sent by the bot itself are also forwarded to the bridge as `contextOnly: true` and `triggerLlm1: false`. This enriches conversation context without causing loops.

## Message Identification

### contextMsgId

A 6-digit per-chat counter (`000000`–`999999`, wraps after `999999`). Used to reference messages in conversations — for example when the bot needs to reply to a specific message or delete a message.

### senderRef

A short deterministic ID per sender per chat, generated from SHA-1 hash of `chatId|senderId`. Used in all LLM interactions — **never** exposes real JIDs to the LLM.

## Data Storage

| Data | Location | Type |
|------|----------|------|
| WhatsApp session | `<folder_path>/auth/` | Files (Baileys auth state) |
| Downloaded media | `<folder_path>/media/` | Files (images, videos, etc.) |
| Sticker catalog | `<folder_path>/stickers/` | Files (WebP) |
| Chat settings & model configs | `<folder_path>/db/settings.db` | SQLite (WAL mode) |
| Dashboard statistics | `<folder_path>/db/stats.db` | SQLite (WAL mode) |
| Mute state | `<folder_path>/db/moderation.db` | SQLite (WAL mode) |
| Sub-agent state | `<folder_path>/db/subagent.db` | SQLite (WAL mode) |
| Sticker DB | `<folder_path>/db/stickers.db` | SQLite (WAL mode) |
| Conversation history | Memory (RAM) | In-memory deque |
| Message cache | Memory (RAM) | In-memory Map |
| Group metadata | Memory (RAM) | TTL cache (60 seconds) |

> **Note:** Each tenant (`folder_path`) is fully isolated under `<folder_path>/{auth,db,media,stickers}`. Databases are split into five separate SQLite files to avoid locking contention. Each uses WAL mode for concurrent reads.

## Module Diagram

### Node.js Gateway

```
src/
├── index.ts              ← Composition root: config, WS server, per-tenant accounts
├── config.ts             ← Single config source — all process.env reads
├── logger.ts             ← Pino structured logging
├── mediaHandler.ts       ← Media download & validation, path resolution
├── server/
│   ├── wsServer.ts        ← WS server: accept clients on WS_LISTEN_PORT, heartbeat
│   └── accountRegistry.ts ← Bind each client to its folder_path AccountEntry
├── account/              ← Per-tenant aggregate (one AccountEntry per folder_path)
│   ├── baileysFactory.ts   ← Create/resume per-tenant Baileys socket; owns DB + repos
│   ├── accountContext.ts   ← Per-account caches/identifiers/sendQueue/forwarder/repos
│   ├── actionDispatcher.ts ← Dispatch Python→Node actions (per-action handlers)
│   └── eventForwarder.ts   ← Forward Node→Python events (per-account reliableQueue)
├── db/                   ← Per-tenant SQLite (no module-global handles)
│   ├── Database.ts         ← Owns one tenant's connections (open/recover/migrate/close)
│   ├── schema/            ← Table creation + migrations
│   └── repositories/      ← Settings, Stats, Model, Activation repositories
├── protocol/
│   ├── types.ts           ← Wire types: frames, WaStatus, AccountEntry, payloads
│   └── ports.ts           ← Interfaces breaking the account/↔wa/ cycle
└── wa/                   ← WhatsApp modules
    ├── domain/            ← caches, identifiers, participants, groupContext, messageParser
    ├── connection.ts      ← Baileys v7 socket lifecycle, button handler
    ├── inbound.ts         ← Incoming messages → normalized incoming_message payload
    ├── outbound.ts        ← Send text/media/mentions
    ├── actions.ts         ← React & delete message wrappers
    ├── moderation.ts      ← Kick members
    ├── presence.ts        ← Mark read & typing indicator
    ├── events.ts          ← Synthetic context events
    ├── sendQueue.ts       ← Per-JID send queue (message ordering)
    ├── command/           ← Typed command dispatch (CommandRegistry + CommandContext)
    ├── commands/          ← Per-command handler modules
    └── interactive/       ← NativeFlow interactive messages
```

### Python Bridge

```
python/
├── wasocket/             ← make_wa_socket SDK (WS CLIENT)
│   ├── socket.py          ← WaSocket class + make_wa_socket factory
│   ├── transport.py       ← WSClientTransport: dial NODE_URL, reconnect, heartbeat
│   ├── protocol.py / events.py     ← Frame dataclasses + WhatsAppMessage model
│   └── correlation.py / errors.py  ← requestId correlation + error hierarchy
└── bridge/
    ├── main.py            ← Boot: load accounts, run one AgentSession per account
    ├── accounts.py         ← Multi-account config loader
    ├── config.py           ← Single config source (env reads, constants)
    ├── session.py          ← AgentSession: composition root (wires agent/ collaborators)
    ├── history.py          ← WhatsAppMessage dataclass, history formatting
    ├── dashboard.py        ← Stats buffer + periodic flush
    ├── stickers.py / sticker_db.py ← Sticker catalog + per-tenant sticker DB
    ├── agent/              ← Injectable per-account collaborators
    ├── db/                 ← Per-domain repositories over the per-tenant core
    ├── media/              ← Media + sticker resolution
    ├── llm/                ← LLM pipeline (llm1, llm2, schemas, prompt, client, ...)
    ├── messaging/          ← Message processing pipeline
    ├── tools/              ← Tool implementations (PIL sticker creation)
    └── subagent/           ← Sub-agent integration
```