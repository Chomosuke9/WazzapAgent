# WazzapAgents

[![Node 18+](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![Python 3.10+](https://img.shields.io/badge/python-%3E%3D3.10-blue)](https://python.org/)
[![License](https://img.shields.io/badge/license-ISC-lightgrey)](./package.json)

WhatsApp AI agent system. **Post-migration the transport direction is reversed:**
the Node.js gateway (Baileys v7) is now the WebSocket **server** (it listens on
`WS_LISTEN_PORT`, default `3000`), and each Python `WaSocket` client **dials**
the gateway at `NODE_URL`, announcing its tenant `folder_path` in a
`hello`/`hello_ack` handshake. The Python bridge runs a two-stage LLM pipeline
(routing + response generation) and sends moderation/action commands back over
the same connection. The gateway supports **multiple WhatsApp accounts**
(tenants), one per `folder_path`, each fully isolated (CONTRACT.md §8).

> **For full architecture, concepts, and developer context** (ADRs, terminology, module descriptions, coding conventions, known gotchas), see [AGENTS.md](./AGENTS.md).
>
> **`CONTRACT.md` is the single source of truth** for the wire protocol
> (§1 handshake/frames), the `make_wa_socket` SDK (§4), and the per-tenant
> folder layout (§8). This README must not contradict it.

---

## Architecture

Reversed topology: **Node is the WS server**, **Python `WaSocket` clients dial
in**. Each Python client owns one tenant (`folder_path`) and dials the shared
Node server at `NODE_URL`; Node binds the client to that account in its registry
after the `hello`/`hello_ack` handshake (CONTRACT.md §1.1).

```
  phone A          phone B            ← one WhatsApp account per tenant
     ↕                ↕                 (Baileys v7 socket, per-tenant auth)
┌──────────────────────────────────────────────────────────────────┐
│  Node.js Gateway — WS SERVER, listens on WS_LISTEN_PORT (:3000)    │
│  src/  (TypeScript)                                                │
│   server/        wsServer.ts (accept), accountRegistry.ts (bind)   │
│   account/       baileysFactory, accountContext, actionDispatcher, │
│                  eventForwarder   (one AccountEntry per folder_path:│
│                  owns its Database + repositories)                 │
│   db/            Database + schema/ + repositories/                │
│   wa/            domain/ + inbound/outbound/actions/moderation +   │
│                  commands/ (CommandRegistry)                       │
│   protocol/      types.ts + ports.ts (wire types, CONTRACT §5)     │
└──────────────────────────────────────────────────────────────────┘
        ▲  hello / hello_ack (§1.1)          ▲
        │  incoming_message, whatsapp_status,│  actions: send_message,
        │  control events, acks  (Node→Py)   │  react, delete, kick, … (Py→Node)
        │                                    │
   dial │ NODE_URL                      dial │ NODE_URL
┌───────┴───────────────┐          ┌─────────┴─────────────┐
│ Python WaSocket A      │          │ Python WaSocket B      │
│ folder_path = tenants/a│          │ folder_path = tenants/b│
│  wasocket/ (SDK §4)    │          │  wasocket/ (SDK §4)    │
│  bridge/  AgentSession │          │  bridge/  AgentSession │
│  (composition root)    │          │  (composition root)    │
│   wiring agent/ collabs:          │   wiring agent/ collabs:
│   ├ BatchProcessor     │          │   ├ BatchProcessor     │
│   ├ Llm1Router         │          │   ├ Llm1Router         │
│   ├ Llm2Responder      │          │   ├ Llm2Responder      │
│   └ SubAgentCoordinator│          │   └ SubAgentCoordinator│
└────────────────────────┘          └────────────────────────┘
   <tenants/a>/{auth,db,media,stickers}   <tenants/b>/{auth,db,media,stickers}
              (CONTRACT §8 — fully isolated per tenant)
```

Multiple Python clients can share one process (the bridge loads an accounts
list and runs one `WaSocket`/`AgentSession` per `folder_path`); a single
account is the degenerate case.

See [AGENTS.md](./AGENTS.md) for ADRs, terminology, and detailed module descriptions.

---

## Prerequisites
- Node.js 18+ (tested with Node 25).
- Python 3.10+.
- pnpm 9+ (`npm i -g pnpm` or `corepack enable pnpm`).
- Internet access to install dependencies.

## Quick Start
1. Copy `.env.example` to `.env`. Set the transport keys: `WS_LISTEN_PORT`
   (Node server listen port, default `3000`) and `NODE_URL` (the URL the Python
   clients dial, default `ws://localhost:3000`). Adjust other values as needed.
2. Install Node deps: `pnpm install`.
3. Install Python deps: `pip install -r requirements.txt`.
4. **Start the Node gateway first** (it is the WS server): `pnpm dev`. It binds
   `WS_LISTEN_PORT` and, per tenant `folder_path`, creates/resumes a Baileys
   socket.
5. **Then start the Python bridge** (the dialing client(s)):
   `python -m bridge.main` (from the repo root, with `PYTHONPATH=python`). Each
   configured account dials `NODE_URL`, sends `hello { folderPath }`, and awaits
   `hello_ack`.
6. Scan the QR printed in the Node logs to pair each WhatsApp account (auth is
   stored under each tenant's `<folder_path>/auth`).

## Accounts configuration (single + multi)

Each account is one tenant folder with the layout
`<folder_path>/{auth,db,media,stickers}` (CONTRACT.md §8). The Python bridge
resolves accounts in this order (first match wins):

1. `ACCOUNTS_JSON` — path to a JSON file, either a list
   `[{"folder_path": "...", "node_url": "..."}, ...]` or an object
   `{"accounts": [...], "node_url": "..."}`. A per-account `node_url` overrides
   the shared `NODE_URL`.
2. `FOLDER_PATHS` — comma-separated tenant folders, all sharing `NODE_URL`.
3. **Single-account fallback** — `FOLDER_PATH` (or `DATA_DIR`, or the repo
   default `data`), sharing `NODE_URL`. This preserves single-account
   boot when no multi-account list is configured.

```dotenv
# single account
FOLDER_PATH=./data
NODE_URL=ws://localhost:3000

# …or multiple accounts, one Baileys socket / WaSocket per folder
FOLDER_PATHS=./tenants/acct-a,./tenants/acct-b
```

## Embedding a `WaSocket` directly (SDK, CONTRACT.md §4)

To drive an account from your own Python code instead of the bundled bridge,
use the `make_wa_socket` factory. It dials the Node server, performs the
handshake, and exposes typed action methods and an `on(event)` decorator:

```python
import asyncio
from wasocket import make_wa_socket   # python/wasocket

async def main():
    sock = make_wa_socket("./tenants/acct-a")   # folder_path == account key

    @sock.on("ready")
    def _ready(_=None):
        print("handshake done; WhatsApp socket bound")

    @sock.on("message")
    async def _on_message(msg):                  # msg: WhatsAppMessage (§7)
        if msg.text and not msg.from_me:
            await sock.send_message(msg.chat_id, "pong", reply_to=msg.context_msg_id)

    await sock.connect("ws://localhost:3000")    # == NODE_URL
    try:
        await asyncio.Event().wait()             # run until cancelled
    finally:
        await sock.disconnect()

asyncio.run(main())
```

## Runtime folders (per tenant — CONTRACT.md §8)
Every `folder_path` owns this isolated layout:
- `<folder_path>/auth`: WhatsApp session files (Baileys multi-file auth). Delete to re-pair **that account only**.
- `<folder_path>/db`: per-tenant SQLite DBs (`settings.db`, `stats.db`, `moderation.db`, `subagent.db`, `stickers.db`).
- `<folder_path>/media`: media downloaded from incoming messages + staged sub-agent output; paths are sent to the LLM.
- `<folder_path>/stickers`: sticker catalog files scanned for LLM2's sticker tool.

---

## WebSocket protocol (gateway ↔ bridge)

Post-migration the **Node gateway is the WS server** and each **Python
`WaSocket` is the client** that dials it. After the `hello`/`hello_ack`
handshake (CONTRACT.md §1.1), JSON frames flow both directions over the single
long-lived connection: **actions** go Python→Node, while **events, control
events and acks** go Node→Python.

### Protocol reliability contract (CONTRACT.md §1.6)

"reliable" = queued in memory and flushed on reconnect (never silently dropped).
"best-effort" = dropped if the socket is not OPEN at send time.

| Frame | Direction | Guarantee |
|-------|-----------|-----------|
| `hello` / `hello_ack` | Python ↔ Node | **reliable** |
| Actions (`send_message`, `react_message`, …) | Python → Node | best-effort |
| `action_ack`, `send_ack`, `error` | Node → Python | best-effort |
| `incoming_message` | Node → Python | best-effort |
| `whatsapp_status` | Node → Python | **reliable** |
| Control events (`clear_history`, `set_llm2_model`, `invalidate_*`, `set_subagent_enabled`) | Node → Python | **reliable** |

The `WaSocket` SDK queues its reliable frames (`hello`) and flushes them on
reconnect; Node queues its reliable Node→Python frames per account
(`reliableQueue`, CONTRACT.md §5) and flushes them when that account's client
reconnects.

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

#### `download_media`

Lazy media (feature 8): fetch the bytes for a previously-forwarded attachment on demand. Inbound `incoming_message` payloads forward attachment **metadata only** (`path: null`, `pending: true`) — no download happens up front. The bridge issues this action when it actually needs the file (vision input, sticker creation, sub-agent), identifying the message by `contextMsgId` or `messageId`.

```json
{
  "type": "download_media",
  "payload": {
    "requestId": "req-dl-001",
    "chatId": "12345@g.us",
    "contextMsgId": "000125"
  }
}
```

**Notes:**
- Provide either `contextMsgId` or `messageId` to identify the source message.
- On success the `action_ack.result` carries the downloaded attachment: `{ path, mime, kind, fileName, originalFileName, jpegThumbnail, size, isAnimated, contextMsgId, messageId }`.
- If the gateway has already evicted the source message proto from its bounded cache, it replies `action_ack` with `ok: false, code: "not_found"` and the bridge degrades gracefully (the attachment is skipped).
- The gateway re-downloads from the cached Baileys message proto via `saveMedia`.

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

Standard acknowledgement for most action commands. Every action type (`send_message`, `react_message`, `delete_message`, `kick_member`, `send_quiz`, `send_buttons`, `send_carousel`, `send_copy_code`, `relay_lottie_sticker`, `run_command`, `download_media`, etc.) produces one. **Exceptions:** `mark_read` and `send_presence` do **not** emit an `action_ack` — they return silently.

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

### Handshake, status & control events (CONTRACT.md §1.1 / §1.4 / §1.5)

The handshake opens every (re)connect: the Python `WaSocket` sends `hello`
(reliable, Python→Node) and Node replies `hello_ack` (reliable) once the
account's Baileys socket is created/resumed and the client is bound in the
registry. `whatsapp_status` (reliable, §1.4) and the control events (reliable,
§1.5) then flow Node→Python. Reliable Node→Python frames are queued per account
and flushed when that account's client reconnects.

`WaStatus = "open" | "connecting" | "close"` is the normalized WhatsApp
lifecycle (Node maps Baileys `connection.update`).

Control events carry their fields at the **top level** of the frame (no
`payload` wrapper) and every Node→Python frame includes `folderPath` so the SDK
can assert tenant ownership.

| Type | Direction | Payload | Trigger |
|------|-----------|---------|---------|
| `hello` | Python → Node | `{ folderPath, protocolVersion: "2.0" }` | First frame on every (re)connect. |
| `hello_ack` | Node → Python | `{ folderPath, waStatus }` | Account's Baileys socket created/resumed + client bound. |
| `whatsapp_status` | Node → Python | `{ folderPath, status, reason?, instanceId }` | WhatsApp connection state change. `reason` is a `DisconnectReason` on `"close"`. |
| `clear_history` | Node → Python | `{ folderPath, chatId \| "global" }` (top-level) | After `/reset`. |
| `set_llm2_model` | Node → Python | `{ folderPath, chatId \| "global", modelId }` (top-level) | After model selection via `/setting`. |
| `invalidate_llm2_model` | Node → Python | `{ folderPath, chatId \| "global" }` (top-level) | After model config change. |
| `invalidate_default_model` | Node → Python | `{ folderPath }` (top-level) | After `/modelcfg`. |
| `invalidate_chat_settings` | Node → Python | `{ folderPath, chatId \| "global" }` (top-level) | After `/mode`, `/prompt`, `/permission`, `/trigger`, `/idle`, `/announcement`. |
| `set_subagent_enabled` | Node → Python | `{ folderPath, chatId \| "global", enabled }` (top-level) | After `/subagent on\|off`. |

**Payload shape examples:**

```json
// hello (Python → Node, handshake; reliable)
{ "type": "hello", "payload": { "folderPath": "/tenants/acct-a", "protocolVersion": "2.0" } }

// hello_ack (Node → Python; reliable)
{ "type": "hello_ack", "payload": { "folderPath": "/tenants/acct-a", "waStatus": "open" } }

// whatsapp_status (Node → Python; reliable)
{ "type": "whatsapp_status", "payload": { "folderPath": "/tenants/acct-a", "status": "open", "instanceId": "gateway-1" } }
{ "type": "whatsapp_status", "payload": { "folderPath": "/tenants/acct-a", "status": "close", "reason": 401, "instanceId": "gateway-1" } }

// control events carry fields at the TOP LEVEL (no payload wrapper):
{ "type": "clear_history", "folderPath": "/tenants/acct-a", "chatId": "12345@g.us" }
{ "type": "clear_history", "folderPath": "/tenants/acct-a", "chatId": "global" }
{ "type": "set_llm2_model", "folderPath": "/tenants/acct-a", "chatId": "12345@g.us", "modelId": "gpt-4o" }
{ "type": "invalidate_llm2_model", "folderPath": "/tenants/acct-a", "chatId": "12345@g.us" }
{ "type": "invalidate_default_model", "folderPath": "/tenants/acct-a" }
{ "type": "invalidate_chat_settings", "folderPath": "/tenants/acct-a", "chatId": "12345@g.us" }
{ "type": "set_subagent_enabled", "folderPath": "/tenants/acct-a", "chatId": "12345@g.us", "enabled": true }
```

**Notes:**
- `chatId: "global"` means the event applies to all chats of that tenant.
- `folderPath` is present on every Node→Python frame so a multi-account SDK can
  route the frame to the owning account.

---

## Notes
- Attachment paths are local; if your LLM service runs elsewhere, you need a file-serving layer or shared volume.
- `delete_message` runs in strict mode: unresolved `contextMsgId` fails without speculative fallback.
- `kick_member` resolves targets via backend senderRef registry and validates each `senderRef` + `anchorContextMsgId` pair before removal.
- If a tenant's WhatsApp session logs out, delete that tenant's `<folder_path>/auth` and re-run to re-pair **that account only**.
- Multi-account: run one process with several tenants (`FOLDER_PATHS` / `ACCOUNTS_JSON`), one Baileys socket + one `WaSocket` per `folder_path`. Each tenant is fully isolated under `<folder_path>/{auth,db,media,stickers}` (CONTRACT.md §8).
- Baileys version pinned to `7.0.0-rc12` (package name `baileys`); ensure Node 18+ with ESM support. rc12 is the patched release for the message-spoofing advisory GHSA-qvv5-jq5g-4cgg (CVE-2026-48063) — do not downgrade below it.
- **Interactive messages** (`viewOnceMessage` + `additionalNodes`) only render on mobile clients, not WhatsApp Web.
- **LLM1 is skipped in private chats** — all DMs get a full LLM2 response (confidence 100).

