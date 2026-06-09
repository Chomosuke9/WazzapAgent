# WazzapAgents

[![Node 18+](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![Python 3.10+](https://img.shields.io/badge/python-%3E%3D3.10-blue)](https://python.org/)
[![License](https://img.shields.io/badge/license-ISC-lightgrey)](./package.json)

WhatsApp AI agent system: a Node.js gateway (Baileys v7) connects a WhatsApp account and forwards messages to a Python LLM bridge over WebSocket. The bridge runs a two-stage LLM pipeline (routing + response generation) and sends moderation/action commands back to the gateway.

> **For full architecture, concepts, and developer context** (ADRs, terminology, module descriptions, coding conventions, known gotchas), see [AGENTS.md](./AGENTS.md).

---

## Architecture

```
WhatsApp (phone)
      ↕  (Baileys v7 socket, multi-file auth)
┌──────────────────────────────────────────────────────┐
│  Node.js Gateway  (src/)                             │
│                                                      │
│  ┌──────────────┐   ┌──────────────┐                │
│  │  connection   │   │  inbound.js  │                │
│  │  lifecycle    │──▶│  message     │─── WS send ──┐│
│  │  (Baileys)   │   │  parser      │               ││
│  └──────────────┘   └──────────────┘               ││
│                                                      ││
│  ┌──────────────┐   ┌──────────────┐               ││
│  │  outbound.js  │   │  actions.js  │               ││
│  │  send text/   │◀──│  react/      │◀── WS recv ──┘│
│  │  media        │   │  delete/kick │                │
│  └──────────────┘   └──────────────┘                │
│                                                      │
│  ┌──────────────┐   ┌──────────────┐                │
│  │  command/    │   │  interactive/ │                │
│  │  slash cmd   │   │  buttons/     │                │
│  │  handlers    │   │  carousel     │                │
│  └──────────────┘   └──────────────┘                │
│                                                      │
│  ┌──────────────┐   ┌──────────────┐                │
│  │  wsClient.js │   │  send()      │                │
│  │  WS lifecycle│   │  sendReliable │                │
│  │  + heartbeat │   │  (queued)    │                │
│  └──────────────┘   └──────────────┘                │
└────────────────────────┬─────────────────────────────┘
                         │ WebSocket (LLM_WS_ENDPOINT)
                ┌────────▼─────────────────────────────┐
                │  Python Bridge  (python/bridge/)      │
                │                                       │
                │  ┌──────────────┐  ┌──────────────┐   │
                │  │  debounce/   │  │  LLM1        │   │
                │  │  batching    │──▶  decision    │   │
                │  │  (5s window) │  │  router      │   │
                │  └──────────────┘  └──────┬───────┘   │
                │                           │ skip?     │
                │                           ▼ no        │
                │  ┌──────────────┐  ┌──────────────┐   │
                │  │  LLM2        │  │  tool        │   │
                │  │  response    │──▶  extraction  │   │
                │  │  generator   │  │  + dispatch  │   │
                │  └──────────────┘  └──────┬───────┘   │
                │                           │           │
                │  ┌──────────────┐         │           │
                │  │  gateway.py  │◀────────┘           │
                │  │  WS send     │                     │
                │  └──────────────┘                     │
                │                                       │
                │  ┌──────────────┐  ┌──────────────┐   │
                │  │  db.py       │  │  actions.py   │   │
                │  │  SQLite CRUD │  │  control line │   │
                │  └──────────────┘  │  parsing      │   │
                │                    └──────────────┘   │
                └───────────────────────────────────────┘
```

See [AGENTS.md](./AGENTS.md) for ADRs, terminology, and detailed module descriptions.

---

## Prerequisites
- Node.js 18+ (tested with Node 25).
- Python 3.10+.
- pnpm 9+ (`npm i -g pnpm` or `corepack enable pnpm`).
- Internet access to install dependencies.

## Quick Start
1. Copy `.env.example` to `.env` and set **required** `LLM_WS_ENDPOINT` (e.g., `ws://localhost:8080/ws`). Adjust other values as needed.
2. Install Node deps: `pnpm install`.
3. Install Python deps: `pip install -r requirements.txt`.
4. Start the Python bridge: `python -m python.bridge.main`.
5. Start the Node gateway: `pnpm dev`.
6. Scan the QR code in the terminal to pair your WhatsApp account (auth stored in `data/auth`).

## Detailed Setup
1. Copy `.env.example` to `.env`, fill required `LLM_WS_ENDPOINT` first, then adjust optional values as needed.
2. Install Node deps: `pnpm install` (Baileys v7 is ESM-only; this project is `type: module`).
3. Install Python deps: `pip install -r requirements.txt` (Python 3.10+).
4. Run the Python bridge: `python -m python.bridge.main`.
5. Run the gateway: `pnpm dev`.
6. Scan the QR in the terminal to pair the WhatsApp account (auth is stored in `data/auth`).

## Runtime folders
- `data/auth`: WhatsApp session files (Baileys multi-file auth). Delete to re-pair.
- `data/media`: Media downloaded from incoming messages; paths are sent to the LLM.
- `data/stickers`: Sticker catalog scanned by the Python bridge for LLM2's sticker tool.

---

## WebSocket protocol (gateway ↔ LLM)

The gateway (Node) connects to the LLM bridge (Python) as a WebSocket client. JSON messages flow in both directions over a single long-lived connection.

### Protocol reliability contract

| Method | Drops when disconnected? | Use for |
|--------|--------------------------|---------|
| `wsClient.send()` | **Yes** — message is lost if WS is not OPEN | Transient payloads: `incoming_message`, action commands (`send_message`, `react_message`, etc.), `action_ack` |
| `wsClient.sendReliable()` | **No** — queued in memory, flushed on reconnect | State-sync events that must not be lost: `whatsapp_status`, `clear_history`, `set_llm2_model`, `invalidate_*`, `set_subagent_enabled` |

The Python bridge uses `ws.send()` for everything — it has no built-in reliable queue (the gateway is the client; if the gateway disconnects, the Python process must re-establish).

---

### Gateway → LLM: `incoming_message`

Sent for every inbound WhatsApp message that passes the activation gate. Bot-originated messages are forwarded as `contextOnly: true` for context enrichment without triggering LLM1.

```json
{
  "type": "incoming_message",
  "payload": {
    "contextMsgId": "000125",
    "messageId": "wamid-abc",
    "instanceId": "dev-gateway-1",
    "chatId": "12345@g.us",
    "chatName": "Group Name",
    "chatType": "group",
    "senderId": "98765@s.whatsapp.net",
    "senderRef": "u8k2d1",
    "senderName": "Alice",
    "senderIsAdmin": false,
    "senderIsSuperAdmin": false,
    "senderIsOwner": false,
    "isGroup": true,
    "botIsAdmin": true,
    "botIsSuperAdmin": false,
    "fromMe": false,
    "contextOnly": false,
    "triggerLlm1": false,
    "timestampMs": 1738560000000,
    "messageType": "extendedTextMessage",
    "text": "Hello world",
    "quoted": {
      "messageId": "wamid-quoted",
      "contextMsgId": "000124",
      "senderId": "555@s.whatsapp.net",
      "text": "Previous message",
      "type": "conversation"
    },
    "attachments": [
      {
        "kind": "image",
        "mime": "image/jpeg",
        "fileName": "wamid_image.jpg",
        "originalFileName": "photo.jpg",
        "size": 12345,
        "path": "data/media/wamid_image.jpg",
        "isAnimated": false,
        "jpegThumbnail": "base64-encoded-thumbnail..."
      }
    ],
    "mentionedJids": ["123@s.whatsapp.net"],
    "mentionedParticipants": [
      {
        "jid": "123@s.whatsapp.net",
        "senderRef": "u1m9qa",
        "name": "Bob"
      }
    ],
    "botMentioned": false,
    "repliedToBot": false,
    "location": null,
    "groupDescription": "Rules and context for this group",
    "slashCommand": null,
    "commandHandled": false
  }
}
```

**Notes:**
- `contextMsgId` — 6-digit per-chat sequence (`000000..999999`, wraps after `999999`). Used as the canonical message reference across the system.
- `senderRef` — Short deterministic reference per sender in each chat (e.g., `u8k2d1`). LLM moderation and tools must use this, never raw JIDs.
- `senderIsOwner` — Whether the sender is a bot owner (configured via `BOT_OWNER_JIDS` env var).
- `senderIsSuperAdmin` — Whether the sender has super-admin role in the group (WhatsApp community super-admin, distinct from group admin).
- `botIsSuperAdmin` — Whether the bot itself is a super-admin (WhatsApp community-level).
- `mentionedParticipants` — Resolved mentions as `{ jid, senderRef, name }` array. Prefer this over `mentionedJids` for LLM context.
- `commandHandled` — `true` when the message is a slash command that was already processed by the Node gateway (so Python should not re-process it). `false` otherwise.
- `botMentioned` / `repliedToBot` — Signal whether the bot was explicitly `@`-mentioned or the message is a direct reply to a bot message.
- `location` — Contains `{ degreesLatitude, degreesLongitude }` for location messages, otherwise `null`.
- `slashCommand` — `{ command, args }` when the message matches a registered slash command prefix, otherwise `null`.
- `messageType: "actionLog"` — Synthetic bot context events emitted after successful moderation actions (e.g., `delete_message`, `kick_member`). These carry an `actionLog: { action, result }` object with details.
- `triggerLlm1` is `false` for all normal incoming messages (including bot echoes). It is only `true` for synthetic events (e.g., group join/leave — see `src/wa/events.js`).
- Bot messages are forwarded with `contextOnly: true` and `triggerLlm1: false` so they enrich context without causing reply loops.
- The backend bridge enforces moderation permissions via the `/permission` command: `DELETE` / `KICK` actions are dropped unless the chat's permission level allows them and the bot has sufficient role (admin / superadmin).

---

### LLM → Gateway: Action commands

Every action command SHOULD include a `requestId` in its payload. The gateway responds with an `action_ack` (or `error`) referencing the same `requestId`.

---

#### `send_message`

Send a text message, optionally with attachments and/or a reply quote.

```json
{
  "type": "send_message",
  "payload": {
    "requestId": "req-send-001",
    "chatId": "12345@g.us",
    "text": "Reply text @Name (u8k2d1) @everyone (everyone)",
    "replyTo": "000124",
    "attachments": [
      {
        "kind": "image",
        "path": "data/media/to-send.jpg",
        "caption": "optional caption text"
      }
    ]
  }
}
```

**Notes:**
- Mention one user inside outgoing text/caption with `@Name (senderRef)`.
- Mention all group members with `@everyone (everyone)` — this sets `nonJidMentions` in WhatsApp's `contextInfo` instead of listing every participant JID individually.
- Invalid `senderRef` mention tokens are silently skipped; the message is still sent.
- `attachments` is optional. Supported `kind` values: `image`, `sticker`, `video`, `audio`, `document`. The `path` is relative to the gateway's working directory. If your LLM service runs on a different machine, you need a shared filesystem or a file-serving layer.
- `replyTo` is a `contextMsgId` string (6 digits). The gateway resolves it to the WhatsApp message ID.
- The gateway emits an `action_ack` on success and a legacy `send_ack` for backward compatibility.

---

#### `react_message`

React to a message with an emoji.

```json
{
  "type": "react_message",
  "payload": {
    "requestId": "req-react-001",
    "chatId": "12345@g.us",
    "contextMsgId": "000125",
    "emoji": "👍"
  }
}
```

---

#### `delete_message`

Delete a message (strict mode — unresolved `contextMsgId` fails without fallback).

```json
{
  "type": "delete_message",
  "payload": {
    "requestId": "req-del-001",
    "chatId": "12345@g.us",
    "contextMsgId": "000125"
  }
}
```

---

#### `kick_member`

Remove one or more members from a group.

```json
{
  "type": "kick_member",
  "payload": {
    "requestId": "req-kick-001",
    "chatId": "12345@g.us",
    "targets": [
      { "senderRef": "u8k2d1", "anchorContextMsgId": "000125" },
      { "senderRef": "u1m9qa", "anchorContextMsgId": "000124" }
    ],
    "mode": "partial_success",
    "autoReplyAnchor": true
  }
}
```

**Notes:**
- Each target is resolved via `senderRef` (not JID), paired with an `anchorContextMsgId` for audit trail.
- `mode`: `"partial_success"` allows some targets to succeed even if others fail; `"all_or_nothing"` rolls back on any failure.
- `autoReplyAnchor`: When `true`, the gateway posts a synthetic action-log message after the kick completes.

---

#### `mark_read`

Mark a chat as read.

```json
{
  "type": "mark_read",
  "payload": {
    "chatId": "12345@g.us",
    "messageId": "wamid-abc",
    "participant": "98765@s.whatsapp.net"
  }
}
```

**Notes:**
- `participant` is optional; include it for group messages to mark the specific sender's message as read.

---

#### `send_presence`

Send a typing indicator / presence update.

```json
{
  "type": "send_presence",
  "payload": {
    "chatId": "12345@g.us",
    "type": "composing"
  }
}
```

**Notes:**
- `type` can be `"composing"` (typing indicator) or `"paused"` (stop typing). Defaults to `"composing"`.

---

#### `send_quiz`

Send an interactive multiple-choice quiz message with quick-reply buttons.

```json
{
  "type": "send_quiz",
  "payload": {
    "requestId": "req-quiz-001",
    "chatId": "12345@g.us",
    "question": "What is the capital of Indonesia?\n\nA. Jakarta\nB. Surabaya\nC. Bandung\nD. Bali",
    "choices": [
      { "label": "A", "text": "A. Jakarta" },
      { "label": "B", "text": "B. Surabaya" },
      { "label": "C", "text": "C. Bandung" },
      { "label": "D", "text": "D. Bali" }
    ],
    "replyTo": "000125",
    "footer": "Choose wisely!"
  }
}
```

**Notes:**
- `question` is the full message body (including any choice listing — the LLM controls the formatting).
- `choices` — each has a single-letter `label` (A–Z, displayed in history) and `text` (the button display text, capped at 20 characters by the bridge).
- `replyTo` — optional `contextMsgId` to quote.
- `footer` — optional footer text rendered below the question.
- When the user taps a button, WhatsApp sends a `templateButtonReplyMessage` with `selectedDisplayText` matching the choice text. This arrives as a normal `incoming_message` on the bridge.
- Only renders on WhatsApp mobile clients (not WhatsApp Web).

---

#### `send_buttons`

Send a generic NativeFlow buttons message (legacy). Supports any button type supported by the gateway's NativeFlow builder.

```json
{
  "type": "send_buttons",
  "payload": {
    "requestId": "req-btns-001",
    "chatId": "12345@g.us",
    "text": "Choose an option:",
    "buttons": [
      { "name": "quick_reply", "buttonParams": { "display_text": "Option A", "id": "opt_a" } },
      { "name": "cta_copy", "buttonParams": { "display_text": "Copy", "copy_code": "ABC123" } }
    ],
    "footer": "Footer text"
  }
}
```

**Notes:**
- `buttons` — array of button objects. Each has a `name` (e.g., `quick_reply`, `cta_copy`, `cta_url`) and `buttonParams` (object, serialized to JSON) or `buttonParamsJson` (pre-serialized string).
- Only renders on WhatsApp mobile clients.

---

#### `send_carousel`

Send a swipeable carousel of interactive cards.

```json
{
  "type": "send_carousel",
  "payload": {
    "requestId": "req-carousel-001",
    "chatId": "12345@g.us",
    "text": "Check these out:",
    "cards": [
      {
        "body": "Card 1 description",
        "footer": "Footer 1",
        "buttons": [
          { "name": "quick_reply", "buttonParams": { "display_text": "Select", "id": "card_1" } }
        ]
      },
      {
        "image": "data/media/card2.jpg",
        "body": "Card 2 description",
        "buttons": [
          { "name": "cta_url", "buttonParams": { "display_text": "Open", "url": "https://example.com" } }
        ]
      }
    ]
  }
}
```

**Notes:**
- `cards` — array of card objects. Each card may have `image` (path), `video` (path), `body` (string), `footer` (string), and `buttons` (same format as `send_buttons`).
- `text` — optional header text above the carousel.
- Only renders on WhatsApp mobile clients.

---

#### `send_copy_code`

Send a CTA copy-code interactive message (NativeFlow button that copies text to clipboard on tap).

```json
{
  "type": "send_copy_code",
  "payload": {
    "requestId": "req-copy-001",
    "chatId": "12345@g.us",
    "code": "PROMO2024",
    "displayText": "Salin Kode",
    "quotedPreviewText": "Your promo code: PROMO2024"
  }
}
```

**Notes:**
- `code` — the text that gets copied to the user's clipboard when they tap the button.
- `displayText` — the button label (defaults to `"Copy Code"`).
- `quotedPreviewText` — optional; when provided, the CTA copy bubble renders as a reply with a synthetic quoted preview showing this text (typically the code itself). The synthetic quote uses a dummy stanza ID — it does not correspond to any real message.
- Only renders on WhatsApp mobile clients.

---

#### `relay_lottie_sticker`

Relay a stored Lottie (animated premium) sticker using its original JSON payload, preserving full animation fidelity.

```json
{
  "type": "relay_lottie_sticker",
  "payload": {
    "requestId": "req-lottie-001",
    "chatId": "12345@g.us",
    "lottiePayload": "{...}"
  }
}
```

**Notes:**
- `lottiePayload` — the raw JSON string of the Lottie sticker payload, previously captured by the `/addsticker` command and stored in the `stickers` table (`lottie_payload` column).
- The Node gateway reconstructs the message via `generateWAMessageFromContent` + `relayMessage`, preserving the original Lottie animation.
- Unlike `send_message` with `kind: "sticker"` (which sends a static `.webp` file), this preserves the animated Lottie format.
- `replyTo` — optional `contextMsgId` to reply to (the gateway resolves it and injects `contextInfo` into the inner `stickerMessage`).

---

#### `run_command`

Silently execute a slash command on the gateway without posting the command text to the WhatsApp chat. The gateway returns an `action_ack` with the canonical command name so the bridge can log a synthetic result.

```json
{
  "type": "run_command",
  "payload": {
    "requestId": "req-rc-001",
    "chatId": "12345@g.us",
    "command": "/sticker",
    "contextMsgId": "000125"
  }
}
```

**Notes:**
- `command` — the slash command string as a human would type it (e.g., `/sticker`, `/catch`, `/info`). The gateway parses it with `parseSlashCommand` and dispatches through the same `handleCommandListener` path as human-typed commands.
- `contextMsgId` — optional, forwarded as the anchor so commands like `/sticker` and `/catch` can resolve the quoted media.
- The synthesised message is treated as if the bot itself typed it (`fromMe: true`, `senderIsOwner: true`).
- The `action_ack` includes `result.command` — the canonical command name — which the bridge uses to append a synthetic `"Command <name> executed successfully"` line to LLM history.
- Unlike `send_message`, this does NOT post any text to the WhatsApp chat.

---

### Acknowledgements and errors

The gateway sends acknowledgements for every action command. The Python bridge should listen for these to track command completion.

#### `action_ack`

Standard acknowledgement for most action commands. Every action type (`send_message`, `react_message`, `delete_message`, `kick_member`, `send_quiz`, `send_buttons`, `send_carousel`, `send_copy_code`, `relay_lottie_sticker`, `run_command`, etc.) produces one. **Exceptions:** `mark_read` and `send_presence` do **not** emit an `action_ack` — they return silently.

```json
{
  "type": "action_ack",
  "payload": {
    "requestId": "req-del-001",
    "action": "delete_message",
    "ok": true,
    "detail": "deleted",
    "code": null,
    "result": {
      "contextMsgId": "000125",
      "messageId": "wamid-abc"
    }
  }
}
```

**Fields:**
- `requestId` — mirrors the `requestId` from the action command.
- `action` — the action type (e.g., `"delete_message"`, `"send_quiz"`).
- `ok` — `true` on success, `false` on failure.
- `detail` — human-readable status (`"sent"`, `"deleted"`, `"reacted"`, `"executed"`, or an error message).
- `code` — stable error code on failure (see below), `null` on success.
- `result` — optional action-specific result object. Common fields include `contextMsgId` and `messageId` of the effected message. For `run_command`, contains `{ command: "sticker" }`.

#### `send_ack`

Legacy compatibility acknowledgement. Only emitted for successful `send_message` actions (in addition to `action_ack`).

```json
{
  "type": "send_ack",
  "payload": {
    "requestId": "req-send-001"
  }
}
```

#### `error`

Emitted for command failures. Includes a stable `code` for programmatic handling.

```json
{
  "type": "error",
  "payload": {
    "message": "delete_message failed",
    "detail": "contextMsgId 000999 not found",
    "code": "not_found",
    "requestId": "req-del-001",
    "action": "delete_message"
  }
}
```

**Stable error codes:**

| Code | Meaning |
|------|---------|
| `not_found` | The target message or resource was not found (e.g., invalid `contextMsgId`). |
| `not_group` | The action requires a group chat but was sent to a private chat (e.g., `kick_member`). |
| `permission_denied` | The bot lacks the required role (admin/superadmin) for this action. |
| `invalid_target` | The target `senderRef` or `contextMsgId` is malformed or unresolvable. |
| `send_failed` | The underlying WhatsApp send operation failed (network, media, rate-limit). |
| `timeout` | The operation timed out (e.g., media download or send exceeded its deadline). |

---

### Control events (Node → Python via `sendReliable`)

These state-sync messages are sent over `wsClient.sendReliable()`, which queues them in memory and flushes when the WebSocket reconnects. They are never lost on disconnect.

| Type | Payload | Trigger |
|------|---------|---------|
| `hello` | `{ instanceId: "...", role: "whatsapp-gateway" }` | Sent once when the WebSocket connection opens (handshake). |
| `whatsapp_status` | `{ status: "open" \| "closed", reason?: number, instanceId: "..." }` | WhatsApp connection state changes. `reason` is a `DisconnectReason` code on `"closed"`. |
| `clear_history` | `{ chatId: "..." }` or `{ chatId: "global" }` | After `/reset` command — clears per-chat message history and caches. |
| `set_llm2_model` | `{ chatId: "...", modelId: "..." }` or `{ chatId: "global", modelId: "..." }` | After `/model` command — authoritative model setting sync (writes to DB). |
| `invalidate_llm2_model` | `{ chatId: "..." }` or `{ chatId: "global" }` | After model config change — clears the cached LLM2 model (re-read from DB on next call). |
| `invalidate_default_model` | `{}` | After `/modelcfg` changes — resets the settings DB connection and clears all model caches. |
| `invalidate_chat_settings` | `{ chatId: "..." }` or `{ chatId: "global" }` | After `/mode`, `/prompt`, `/permission`, `/trigger`, `/idle`, or `/announcement` changes — clears per-chat cached settings (mode, prompt, permissions, triggers). |
| `set_subagent_enabled` | `{ chatId: "...", enabled: true \| false }` | After `/subagent on\|off` — invalidates the sub-agent enabled cache so the new value is re-read from DB. |

**Payload shape examples:**

```json
// hello (handshake, sent once on WS open)
{ "type": "hello", "payload": { "instanceId": "gateway-1", "role": "whatsapp-gateway" } }

// whatsapp_status
{ "type": "whatsapp_status", "payload": { "status": "open", "instanceId": "gateway-1" } }
{ "type": "whatsapp_status", "payload": { "status": "closed", "reason": 401, "instanceId": "gateway-1" } }

// clear_history
{ "type": "clear_history", "chatId": "12345@g.us" }
{ "type": "clear_history", "chatId": "global" }

// set_llm2_model
{ "type": "set_llm2_model", "chatId": "12345@g.us", "modelId": "gpt-4o" }

// invalidate_llm2_model
{ "type": "invalidate_llm2_model", "chatId": "12345@g.us" }

// invalidate_default_model
{ "type": "invalidate_default_model" }

// invalidate_chat_settings
{ "type": "invalidate_chat_settings", "chatId": "12345@g.us" }

// set_subagent_enabled
{ "type": "set_subagent_enabled", "chatId": "12345@g.us", "enabled": true }
```

**Notes:**
- `chatId: "global"` means the event applies to all chats (e.g., clearing all history, or setting a global default model).
- The `hello` event is purely informational; the Python handler logs the payload and continues.

---

## Notes
- Attachment paths are local; if your LLM service runs elsewhere, you need a file-serving layer or shared volume.
- `delete_message` runs in strict mode: unresolved `contextMsgId` fails without speculative fallback.
- `kick_member` resolves targets via backend senderRef registry and validates each `senderRef` + `anchorContextMsgId` pair before removal.
- If the WhatsApp session logs out, delete `data/auth` and re-run to re-pair.
- Multi-account: run multiple gateway instances with different `INSTANCE_ID` and separate `DATA_DIR` / `MEDIA_DIR`.
- Baileys version pinned to `7.0.0-rc.9` (package name `baileys`); ensure Node 18+ with ESM support.
- **Interactive messages** (`viewOnceMessage` + `additionalNodes`) only render on mobile clients, not WhatsApp Web.
- **LLM1 is skipped in private chats** — all DMs get a full LLM2 response (confidence 100).

## Example LLM WebSocket (Python)
See `examples/llm_ws_echo.py` for a minimal server that:
- Listens on `ws://0.0.0.0:8080/ws`.
- Logs `incoming_message` payload including `contextMsgId` and `senderRef`.
- Sends `send_message`, `delete_message`, `react_message`, and `kick_member` examples.

Run:
```bash
pip install websockets==12.* pydantic
python examples/llm_ws_echo.py
```
