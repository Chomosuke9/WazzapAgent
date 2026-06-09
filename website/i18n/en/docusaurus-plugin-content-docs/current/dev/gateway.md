---
sidebar_position: 3
---

# Node.js Gateway

Internal documentation for the Node.js Gateway (`src/`). The gateway connects WhatsApp to the Python bridge via WebSocket.

## Tech Stack

- **Runtime:** Node.js 18+ with ESM (`"type": "module"`)
- **WhatsApp Library:** Baileys v7 (`baileys@7.0.0-rc.9`)
- **WebSocket:** `ws` library
- **Logging:** Pino (structured JSON logging)
- **File System:** `fs-extra`

## Entry Point (`index.js`)

`index.js` is the main bootstrap:

1. Validates `LLM_WS_ENDPOINT` exists in environment.
2. Runs `startWhatsApp()` for WhatsApp connection.
3. Listens for `message` events from the WebSocket client.
4. Routes commands from the bridge to the appropriate WhatsApp functions.

```js
// Command routing flow
wsClient.on('message', async (msg) => {
  switch (msg.type) {
    case 'send_message':    → sendOutgoing(payload)
    case 'react_message':   → reactToMessage(payload)
    case 'delete_message':  → deleteMessageByContextId(payload)
    case 'kick_member':     → kickMembers(payload)
    case 'mark_read':       → markChatRead(payload)
    case 'send_presence':   → sendPresence(payload)
  }
});
```

Each action returns an `action_ack` to the bridge. For `send_message`, a legacy `send_ack` is also emitted.

## WhatsApp Client (`connection.js`)

### Connection

Uses `makeWASocket` from Baileys with auth state stored in `data/auth/`. On first run, displays a QR code in the terminal.

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

The `@everyone (everyone)` token resolves to mentioning all group members.

## Message Parser (`messageParser.js`)

The parser extracts structured information from raw Baileys messages:

### Extracted Data

| Field | Source |
|-------|--------|
| `text` | `conversation`, `extendedTextMessage`, media captions, reactions, contacts, interactive |
| `quoted` | `contextInfo.quotedMessage` — sender, text, type, location |
| `mentionedJids` | `contextInfo.mentionedJid` |
| `location` | `locationMessage`, `liveLocationMessage` |
| `attachments` | Downloaded media results (image, video, audio, document, sticker) |

### Text Extraction Priority

The parser tries text sources in priority order:

1. `conversation` (plain text message)
2. `extendedTextMessage.text` (text with formatting/links)
3. Interactive responses (button, template, list)
4. Media captions (image/video/document)
5. Reactions → `react:{emoji}`
6. Contacts → `<contact: Name, Phone>`
7. Media placeholders → `<media:image>`, `<media:video>`, etc.

## Identifiers (`identifiers.js`)

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

## Media Handler (`mediaHandler.js`)

### Download Flow

1. Receive media stream from Baileys.
2. Validate MIME type.
3. Save to `MEDIA_DIR` (`data/media/`).
4. Return metadata (kind, mime, fileName, size, path).

### Security

- Media paths are sandboxed to `MEDIA_DIR` — no directory traversal possible.
- File sizes are limited to prevent OOM.

## Caches (`caches.js`)

| Cache | Type | Max Size | TTL |
|-------|------|----------|-----|
| `messageCache` | `Map<messageId, rawMsg>` | 5000 | - |
| `messageKeyIndex` | `Map<chatId::contextMsgId, entry>` | 10000 | - |
| `messageIdToContextId` | `Map<chatId::messageId, contextMsgId>` | 20000 | - |
| `contextCounterByChat` | `Map<chatId, counter>` | - | - |
| `senderRefRegistryByChat` | `Map<chatId, registry>` | - | - |
| Group metadata | Via `groupContext.js` | - | 60 seconds |

## Group Context (`groupContext.js`)

### Metadata Caching

Group metadata (name, description, participants) is cached with a 60-second TTL. After expiry, it's re-fetched from WhatsApp.

## WebSocket Client (`wsClient.js`)

- Extends `EventEmitter`.
- Auto-reconnects on disconnection (interval configurable via `WS_RECONNECT_MS`).
- Sends a `hello` message on connect with `instanceId` and `role`.
- Supports `Authorization: Bearer <token>` header.

## Code Conventions

- ESM modules (`import`/`export`).
- 2-space indentation, single quotes.
- Async/await for all asynchronous operations.
- Structured logging via `logger` with context objects.
- No formatter/linter configured — match existing style and keep diffs minimal.
