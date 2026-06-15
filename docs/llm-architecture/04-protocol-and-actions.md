# 04 - Protocol and Actions

## Node → Python events

### `incoming_message`
The primary event containing a normalized chat message payload. Sent for every
inbound message that passes the activation gate. Bot-originated messages are
forwarded as `contextOnly: true` for context enrichment without triggering LLM1.

Key fields:

| Field | Type | Description |
|-------|------|-------------|
| `instanceId` | `string` | Bot instance identifier (always present) |
| `chatId` | `string` | Chat JID (`12345@g.us` or `12345@s.whatsapp.net`) |
| `chatType` | `string` | `"group"` or `"private"` |
| `chatName` | `string` | Display name of the chat |
| `senderId` | `string` | Sender JID |
| `senderRef` | `string` | Short 6-char LLM-friendly reference (e.g. `u8k2d1`) |
| `senderName` | `string` | Sender display name |
| `senderIsAdmin` | `boolean` | Sender is a group admin |
| `senderIsSuperAdmin` | `boolean` | Sender is a WhatsApp community super-admin |
| `senderIsOwner` | `boolean` | Sender is a bot owner (from `BOT_OWNER_JIDS`) |
| `isGroup` | `boolean` | Whether the chat is a group |
| `botIsAdmin` | `boolean` | Bot has admin role in the group |
| `botIsSuperAdmin` | `boolean` | Bot is a WhatsApp community super-admin |
| `fromMe` | `boolean` | Message was sent by the bot itself |
| `contextOnly` | `boolean` | `true` for bot's own echoed messages (enrich context only, do not trigger LLM1) |
| `triggerLlm1` | `boolean` | Whether LLM1 should process this message. `false` for bot's own messages and context-only entries. |
| `contextMsgId` | `string` | 6-digit per-chat sequence number (`000000`–`999999`, wraps) |
| `messageId` | `string` | WhatsApp native message ID (`wamid-...`) |
| `timestampMs` | `number` | Unix timestamp in milliseconds |
| `messageType` | `string` | WhatsApp message type. Synthetic types not from WhatsApp: `"actionLog"` (bot action context events), `"groupParticipantsUpdate"` (join/leave events), `"botRoleChange"` (bot promoted/demoted). |
| `text` | `string\|null` | Message text content |
| `quoted` | `object\|null` | Quoted/replied-to message: `{ messageId, contextMsgId, senderId, text, type }` |
| `attachments` | `array` | Media attachments: `[{ kind, mime, fileName, size, path, isAnimated }]` |
| `mentionedJids` | `string[]` | Raw JIDs of mentioned participants |
| `mentionedParticipants` | `array` | Resolved mentions as `[{ jid, senderRef, name }]` — prefer over `mentionedJids` |
| `botMentioned` | `boolean` | Bot was `@`-mentioned |
| `repliedToBot` | `boolean` | Message is a direct reply to a bot message |
| `location` | `object\|null` | Location data `{ degreesLatitude, degreesLongitude }` or `null` |
| `groupDescription` | `string\|null` | Group description text for LLM context |
| `slashCommand` | `object\|null` | Parsed slash command: `{ command, args }` or `null` |
| `commandHandled` | `boolean` | Whether this slash command was already processed by Node (Python should not re-process) |
| `actionLog` | `object\|null` | Present when `messageType === "actionLog"`: `{ action, result }` details |

### Handshake, status & control events

The `hello`/`hello_ack` handshake opens every (re)connect: the Python `WaSocket`
sends `hello` (reliable, Python→Node) and Node replies `hello_ack` (reliable)
once the account's Baileys socket is created/resumed and the client is bound.
`whatsapp_status` and the control events then flow Node→Python; reliable
Node→Python frames are queued per account on the registry
(`sendReliableToClient()`) and flushed when that account's client reconnects.

Every Node→Python frame carries `folderPath` for tenant routing. Control events
carry their fields at the **top level** of the frame (no `payload` wrapper).

| Event | Direction | Payload | Trigger |
|-------|-----------|---------|---------|
| `hello` | Python → Node | `{ folderPath, protocolVersion: "2.0" }` | First frame on every (re)connect (reliable) |
| `hello_ack` | Node → Python | `{ folderPath, waStatus }` | Account's Baileys socket created/resumed + client bound (reliable) |
| `whatsapp_status` | Node → Python | `{ folderPath, status, reason?, instanceId }` | WhatsApp connection state changes |
| `clear_history` | Node → Python | `{ folderPath, chatId \| "global" }` (top-level) | After `/reset` |
| `set_llm2_model` | Node → Python | `{ folderPath, chatId \| "global", modelId }` (top-level; `modelId: null` when the model is deleted) | After model selection via `/setting` |
| `invalidate_llm2_model` | Node → Python | `{ folderPath, chatId \| "global" }` (top-level) | After model config change |
| `invalidate_default_model` | Node → Python | `{ folderPath }` (top-level) | After `/modelcfg` |
| `invalidate_chat_settings` | Node → Python | `{ folderPath, chatId \| "global" }` (top-level) | After `/prompt`, `/permission`, `/trigger`, `/idle`, or `/announcement` changes |
| `set_subagent_enabled` | Node → Python | `{ folderPath, chatId \| "global", enabled }` (top-level) | After `/subagent on\|off` |

See `README.md` for full payload shape examples for each control event.

## Python → Node actions

| Action | Required fields | Description |
|--------|----------------|-------------|
| `send_message` | `chatId`, `text` | Send text/media reply (see README for attachment, sticker, and mention formats) |
| `react_message` | `chatId`, `contextMsgId`, `emoji` | React with a single emoji |
| `delete_message` | `chatId`, `contextMsgId` | Delete a message by its contextMsgId |
| `kick_member` | `chatId`, `targets[]` | Remove members from group (validates senderRef + anchorContextMsgId) |
| `mark_read` | `chatId`, `messageId` | Mark messages as read |
| `send_presence` | `chatId`, `type` | Send typing (`"composing"`) or paused indicator |
| `send_quiz` | `chatId`, `question`, `choices[]` | Send multiple-choice quiz with quick-reply buttons (2–5 choices, mobile only) |
| `send_copy_code` | `chatId`, `code` | Send CTA copy-code interactive message (mobile only) |
| `relay_lottie_sticker` | `chatId`, `lottiePayload` | Relay stored Lottie sticker JSON preserving full animation |
| `send_buttons` | `chatId`, `text`, `buttons` | NativeFlow button message (legacy) |
| `send_carousel` | `chatId`, `cards[]` | Swipeable carousel cards |
| `run_command` | `chatId`, `command` | Execute a slash command silently (not posted to WhatsApp). Optional `contextMsgId` for anchor. |
| `download_media` | `chatId`, `contextMsgId` \| `messageId` | Lazily fetch the bytes for a previously-forwarded attachment on demand (vision / sticker / sub-agent). Inbound forwards metadata only (`path: null`, `pending: true`). |

## Ack/Error responses (Node → Python)

| Type | Fields | Description |
|------|--------|-------------|
| `action_ack` | `requestId`, `action`, `ok`, `detail`, `result?`, `code?` | Action result confirmation — emitted for most actions (not for `mark_read` or `send_presence` on success) |
| `send_ack` | `requestId` | Legacy compat — emitted alongside `action_ack` for successful `send_message` |
| `error` | `message`, `detail`, `code`, `requestId?`, `action?` | Action failure with stable error code |

### Stable error codes

| Code | Meaning |
|------|---------|
| `not_found` | The target message or resource was not found (e.g. invalid `contextMsgId`) |
| `not_group` | The action requires a group chat but was sent to a private chat (e.g. `kick_member`) |
| `permission_denied` | The bot lacks the required role (admin/superadmin) for this action |
| `invalid_target` | The target `senderRef` or `contextMsgId` is malformed or unresolvable |
| `send_failed` | The underlying WhatsApp send operation failed (network, media, rate-limit) |
| `timeout` | The operation timed out (e.g. media download or send exceeded its deadline) |

### action_ack result formats

The `result` field is action-specific:

| Action | result shape |
|--------|-------------|
| `send_message` | `{ sent: Array<{kind, contextMsgId, messageId}>, replyTo: string\|null }` |
| `react_message` | `{ contextMsgId }` |
| `delete_message` | `{ contextMsgId }` |
| `kick_member` | `{ succeeded: int, failed: int, results: [{ target, ok, detail? }] }` |
| `run_command` | `{ command: string\|null }` on success, `{ command: null, error: string }` on error |
| `send_quiz` | `{ contextMsgId, messageId }` |
| `send_copy_code` | Raw Baileys message object from `generateWAMessageFromContent` (the full `msg` with `key`, `message`, etc.) |
| `relay_lottie_sticker` | `{ contextMsgId, messageId }` |
| `send_buttons` | Raw Baileys message object from `generateWAMessageFromContent` (the full `msg` with `key`, `message`, etc.) |
| `send_carousel` | Raw Baileys message object from `generateWAMessageFromContent` (the full `msg` with `key`, `message`, etc.) |
| `download_media` | `{ path, mime, kind, fileName, originalFileName, jpegThumbnail, size, isAnimated, contextMsgId, messageId }` on success; `ok: false, code: "not_found"` if the source proto was evicted |

See `README.md` § *Acknowledgements and errors* for full JSON examples.

## Quiz message tracking

When the LLM sends a `send_quiz` action, the Node gateway tracks the WhatsApp
message ID of the sent quiz in an in-memory `quizMessageIds` Set (bounded to
2000 entries via FIFO eviction). When the user taps a quiz button, WhatsApp
sends a `templateButtonReplyMessage` that arrives as a normal
`incoming_message`. The Python bridge does not need to distinguish quiz
replies from other messages — it simply processes all incoming messages.

The `quizMessageIds` set exists on the Node side to distinguish quiz button
replies from settings menu replies (both use the same button interaction
path). Quiz button replies are forwarded to the LLM; settings menu replies
are handled locally and suppressed.

Bots send a synthetic `[QUESTION SENT]` history entry so LLM2 sees its own
quiz on the next turn.

## Reliability contract
- Critical control events from Node to Python **must** use `sendReliableToClient()` to survive WS reconnects.
- If that account's client is not OPEN, reliable events are stored in a per-account in-memory queue (max 1000 entries, oldest dropped on overflow).
- The queue is flushed when that account's client reconnects.
- Regular `incoming_message` events use `sendToClient()` (best-effort) because they're transient.

## Full payload reference
See `README.md` for the complete `incoming_message`, `send_message`, and all
other action payload contracts with full JSON examples.