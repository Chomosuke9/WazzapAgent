---
sidebar_position: 3
---

# Node.js Gateway

Internal documentation for the Node.js Gateway (`src/`, TypeScript). The gateway is the **WebSocket server**: it binds `WS_BIND_HOST:WS_LISTEN_PORT` (default `127.0.0.1:3000`), and each Python `WaSocket` is a **client** that dials in at `NODE_URL` (default `ws://localhost:3000`) to bridge WhatsApp to the LLM pipeline.

## Tech Stack

- **Runtime:** Node.js 18+ with ESM (`"type": "module"`)
- **WhatsApp Library:** Baileys v7 (`baileys@7.0.0-rc14`)
- **WebSocket:** `ws` library
- **Logging:** Pino (structured JSON logging)
- **File System:** `fs-extra`

## Entry Point (`index.ts`)

`index.ts` is the main composition root:

1. Reads configuration and binds the WebSocket **server** on `WS_BIND_HOST:WS_LISTEN_PORT` (default `127.0.0.1:3000`).
2. Loads the account catalog and creates/resumes a per-account Baileys socket for each tenant `folder_path`.
3. Accepts connections from Python `WaSocket` clients that dial in at `NODE_URL`, binding each to its account via the registry after the `hello`/`hello_ack` handshake.
4. Routes **actions** from the bridge (Python→Node) to the appropriate WhatsApp functions, per account via `src/account/actionDispatcher.ts`.
5. Serves the authenticated control panel and supervises hot account add/remove operations.

```js
// Action dispatch (Python → Node), per account via src/account/actionDispatcher.ts
'send_message'          → sendOutgoing(payload)
'react_message'         → reactToMessage(payload)
'delete_message'        → deleteMessageByContextId(payload)
'kick_member'           → kickMembers(payload)
'mark_read'             → markChatRead(payload)
'send_presence'         → sendPresence(payload)
'run_command'           → runCommand(payload)
'send_quiz' / 'send_copy_code' / 'relay_lottie_sticker'
'send_buttons' / 'send_carousel'
'download_media'        → lazily fetch cached inbound media bytes
```

Each action returns an `action_ack` to the bridge (Node→Python). For `send_message`, a legacy `send_ack` is also emitted. Every Node→Python frame carries `folderPath` for tenant routing.

## WhatsApp Client (`src/wa/connection.ts`)

### Connection

Uses `makeWASocket` from Baileys with auth state stored in
`<folder_path>/auth/`. First pairing can use `WA_PAIRING_NUMBER` for a native
code, a code requested from the control panel, or a QR code.

### Event Handling

- **`messages.upsert`** — Main event when messages arrive. Each message is parsed, assigned a contextMsgId, and sent to the bridge.
- **`group-participants.update`** — Detects members joining/leaving groups.
- **`connection.update`** — Manages connection status and reconnection.

### Moderation Actions

| Function | Description |
|----------|-------------|
| `sendOutgoing(payload)` | Send text/media message with mention and reply support |
| `reactToMessage(payload)` | Add emoji reaction to a message |
| `deleteMessageByContextId(payload)` | Delete message by contextMsgId |
| `kickMembers(payload)` | Kick members from group (supports `partial_success` mode) |
| `markChatRead(payload)` | Mark message as read (blue check) |
| `sendPresence(payload)` | Send typing indicator (`composing`/`paused`) |

### Mention Resolution

When sending messages, the gateway resolves `@Name (senderRef)` tokens in text to valid WhatsApp JIDs:

```
Input text:  "Hey @whoami (u8k2d1), stop spamming"
Resolution:  senderRef "u8k2d1" → JID "628123456789@s.whatsapp.net"
Output text: "Hey @628123456789, stop spamming" (with mention tag)
```

The `@all (all)` token resolves to mentioning all group members.

## Message Parser (`src/wa/domain/messageParser.ts`)

The parser extracts structured information from raw Baileys messages:

### Extracted Data

| Field | Source |
|-------|--------|
| `text` | `conversation`, `extendedTextMessage`, media captions, reactions, contacts, interactive |
| `quoted` | `contextInfo.quotedMessage` — sender, text, type, location |
| `mentionedJids` | `contextInfo.mentionedJid` |
| `location` | `locationMessage`, `liveLocationMessage` |
| `attachments` | Lazy media metadata (image, video, audio, document, sticker) |

### Text Extraction Priority

The parser tries text sources in priority order:

1. `conversation` (plain text message)
2. `extendedTextMessage.text` (text with formatting/links)
3. Interactive responses (button, template, list)
4. Media captions (image/video/document)
5. Reactions → `react:{emoji}`
6. Contacts → `<contact: Name, Phone>`
7. Media placeholders → `<media:image>`, `<media:video>`, etc.

## Identifiers (`src/wa/domain/identifiers.ts`)

### contextMsgId

- 6-digit counter per chat: `000000` through `999999`.
- Increments with each new message in that chat.
- Wraps back to `000000` after `999999`.
- Stored in `contextCounterByChat` Map.
- Indexed in `messageKeyIndex` for fast lookup.

### senderRef

- Short 6-character ID per sender per chat.
- Generated from SHA-1 hash: `sha1(chatId|senderId|attempt)` → base36, 6 chars.
- Collision handling: retry with incrementing `attempt` (max 128 attempts).
- Per-chat registry: `senderToRef`, `refToSender`, `senderToParticipant`.
- **Purpose:** Ensures real JIDs are never exposed to the LLM.

## Media Handler (`src/mediaHandler.ts`)

### Download Flow

1. Forward attachment metadata with `path: null` and `pending: true`; do not download bytes during normal ingress.
2. Keep the raw message proto in the bounded per-account cache.
3. When the bridge needs bytes for vision, stickers, or a Sub-Agent task, it sends `download_media`.
4. Download through Baileys, validate the detected MIME type, and save under the tenant media directory.
5. Return the resolved path in `action_ack.result`, or `not_found` if the source proto was evicted.

### Security

- Media paths are sandboxed to `MEDIA_DIR` — no directory traversal possible.
- File sizes are limited to prevent OOM.

## Caches (`src/wa/domain/caches.ts`)

| Cache | Type | Max Size | TTL |
|-------|------|----------|-----|
| `messageCache` | `Map<messageId, rawMsg>` | 1000 | - |
| `messageKeyIndex` | `Map<chatId::contextMsgId, entry>` | 12000 | - |
| `messageIdToContextId` | `Map<chatId::messageId, contextMsgId>` | 24000 | - |
| `contextCounterByChat` | `Map<chatId, counter>` | - | - |
| `senderRefRegistryByChat` | `Map<chatId, registry>` | - | - |
| Group metadata | Via `groupContext.ts` | - | 60 seconds |

## Group Context (`src/wa/domain/groupContext.ts`)

### Metadata Caching

Group metadata (name, description, participants) is cached with a 60-second TTL. After expiry, it's re-fetched from WhatsApp.

## WebSocket Server (`src/server/wsServer.ts`)

Post-migration the topology is **reversed**: **Node is the WebSocket server**, not a client. Each Python `WaSocket` is a client that dials Node at `NODE_URL` (default `ws://localhost:3000`).

- Binds the `ws` server on `WS_BIND_HOST:WS_LISTEN_PORT` (default `127.0.0.1:3000`).
- Accepts client connections and runs a per-connection heartbeat (`WS_HEARTBEAT_INTERVAL_MS`).
- Supports an optional bearer token via `LLM_WS_TOKEN` (enforced by Node, sent by the Python client).
- `src/server/accountRegistry.ts` binds each client to its `folder_path` after the `hello` handshake (Python→Node, `{folderPath, protocolVersion: "2.0", authToken?}`) / `hello_ack` (Node→Python, `{folderPath, waStatus}`). Managed accounts must present their own generated credential in addition to any process-level bearer token.

After the handshake: **actions** flow Python→Node; **events**, control events, and acks flow Node→Python. Every Node→Python frame carries `folderPath` for tenant routing.

> Start order: start the **Node gateway first** (the server), then the Python bridge (clients dial in).

## Control Panel (`src/controlPanel/`)

The gateway also owns the control-plane HTTP server. Static assets and the
setup-status probe can load without a token, but every management API is
fail-closed until `CONTROL_PANEL_TOKEN` is configured. The panel operates on
the live account registry and per-tenant repositories, persists a bounded audit
log, masks secrets in `.env`, and marks settings that require restart.

The managed `accounts.json` catalog assigns every tenant a stable runtime slot
and unique WebSocket credential. Paths are canonicalized and allowlisted before
runtime state is created. Removing an account stops its runtime but deliberately
preserves tenant data.

## Code Conventions

- ESM modules (`import`/`export`).
- 2-space indentation, single quotes.
- Async/await for all asynchronous operations.
- Structured logging via `logger` with context objects.
- No formatter/linter configured — match existing style and keep diffs minimal.
