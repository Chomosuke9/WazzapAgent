---
sidebar_position: 5
---

# WebSocket Protocol

The gateway and bridge communicate via JSON messages over WebSocket. This page documents all message types and their payloads.

## Connection

1. Gateway connects to bridge at the configured URL (`LLM_WS_ENDPOINT`).
2. If `LLM_WS_TOKEN` is set, gateway sends an `Authorization: Bearer <token>` header.
3. After connecting, gateway sends a `hello` message:

```json
{
  "type": "hello",
  "payload": {
    "instanceId": "dev-gateway-1",
    "role": "whatsapp-gateway"
  }
}
```

4. If the connection drops, gateway auto-reconnects after `WS_RECONNECT_MS` (default 5 seconds).

## Gateway → Bridge

### `incoming_message`

Sent whenever a message arrives on WhatsApp.

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
    "senderIsOwner": false,
    "isGroup": true,
    "botIsAdmin": true,
    "botIsSuperAdmin": false,
    "fromMe": false,
    "contextOnly": false,
    "triggerLlm1": false,
    "timestampMs": 1738560000000,
    "messageType": "extendedTextMessage",
    "text": "Hello everyone",
    "quoted": {
      "messageId": "wamid-quoted",
      "contextMsgId": "000124",
      "senderId": "555@s.whatsapp.net",
      "senderName": "Bob",
      "text": "Previous message",
      "type": "conversation"
    },
    "attachments": [
      {
        "kind": "image",
        "mime": "image/jpeg",
        "fileName": "wamid_image.jpg",
        "size": 12345,
        "path": "data/media/wamid_image.jpg",
        "isAnimated": false
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
    "groupDescription": "Group description",
    "slashCommand": null
  }
}
```

#### Key Fields

| Field | Type | Description |
|-------|------|-------------|
| `contextMsgId` | `string` | 6-digit per-chat counter (`000000`–`999999`) |
| `senderRef` | `string` | Short deterministic ID per sender, **not a JID** |
| `contextOnly` | `boolean` | `true` for bot's own messages (enrichment, doesn't trigger LLM) |
| `triggerLlm1` | `boolean` | Whether the message should pass through LLM1 gating |
| `botMentioned` | `boolean` | Bot was mentioned in the message |
| `repliedToBot` | `boolean` | Message replies to the bot's message |
| `senderIsOwner` | `boolean` | Sender is a bot owner (from `BOT_OWNER_JIDS`) |
| `slashCommand` | `object\|null` | `{ command, args }` if message is a slash command |
| `messageType` | `string` | Baileys message type (can be `"actionLog"` for synthetic events) |

#### Notes

- Bot messages are sent as `contextOnly: true` and `triggerLlm1: false`.
- Gateway may emit synthetic events with `messageType: "actionLog"` after successful moderation actions.
- `mentionedParticipants` resolves JIDs into `{ jid, senderRef, name }`.
### `action_ack`

Sent as a response whenever an action from the bridge succeeds or fails.

```json
{
  "type": "action_ack",
  "payload": {
    "requestId": "req-del-001",
    "action": "delete_message",
    "ok": true,
    "detail": "deleted",
    "result": {
      "contextMsgId": "000125",
      "messageId": "wamid-abc"
    }
  }
}
```

#### Error Format

When an action fails, the gateway also sends an `error` message:

```json
{
  "type": "error",
  "payload": {
    "message": "delete_message failed",
    "detail": "message not found in cache",
    "code": "not_found",
    "requestId": "req-del-001",
    "action": "delete_message"
  }
}
```

**Error codes:** `not_found`, `not_group`, `permission_denied`, `invalid_target`, `send_failed`.

## Bridge → Gateway

### `send_message`

Send a message to a WhatsApp chat.

```json
{
  "type": "send_message",
  "payload": {
    "requestId": "req-send-001",
    "chatId": "12345@g.us",
    "text": "Hey @whoami (u8k2d1), welcome! @everyone (everyone)",
    "replyTo": "000124",
    "attachments": [
      {
        "kind": "image",
        "path": "data/media/to-send.jpg",
        "caption": "Optional"
      }
    ]
  }
}
```

#### Mentions

| Syntax | Description |
|--------|-------------|
| `@Name (senderRef)` | Mention one user (resolves to JID) |
| `@everyone (everyone)` | Mention all group members |

Invalid `@Name (senderRef)` tokens are silently skipped (message still sends).

#### Reply

The `replyTo` field accepts a `contextMsgId` (6 digits). Gateway resolves it to a Baileys message key for quoting.

### `react_message`

Add an emoji reaction to a message.

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

### `delete_message`

Delete a message from a chat (bot must be admin).

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

:::warning
`delete_message` runs in strict mode — if `contextMsgId` is not found in the cache, the action fails immediately without fallback.
:::

### `kick_member`

Kick members from a group.

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

| Field | Description |
|-------|-------------|
| `targets[].senderRef` | senderRef of the target to kick |
| `targets[].anchorContextMsgId` | contextMsgId for identity verification |
| `mode` | `"partial_success"` — continue even if some targets fail |
| `autoReplyAnchor` | Auto-reply to anchor message after kick |

### `mark_read`

Mark a message as read (blue check).

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

`participant` is optional; include it for group messages.

### `send_presence`

Send a typing indicator.

```json
{
  "type": "send_presence",
  "payload": {
    "chatId": "12345@g.us",
    "type": "composing"
  }
}
```

`type`: `"composing"` (typing) or `"paused"` (stopped typing). Defaults to `"composing"`.

## Legacy Compatibility

| Event | Description |
|-------|-------------|
| `send_ack` | Still emitted for successful `send_message` |
| `error` | Emitted for command failures with stable `code` values |

## Protocol Security

### Moderation Gating

The bridge enforces gating for moderation actions based on the permission level set via the `/permission` command:

- `DELETE` is only executed if the permission level allows it (level 1 or 3) **AND** bot is admin.
- `KICK` is only executed if the permission level allows it (level 2 or 3) **AND** bot is admin.

Permissions are managed using the `/permission <0-3>` command and stored in the per-chat database.

### senderRef Isolation

Real JIDs are never sent to the LLM. All user references use `senderRef`, which is a short deterministic hash.

## Implementing a Custom Bridge

To implement a custom bridge, you need to:

1. **WebSocket server** listening at the configured endpoint.
2. **Handle `incoming_message`** — receive and process messages.
3. **Send commands** — use the formats above to send actions.
4. **Handle `action_ack`/`error`** — track action status.

A minimal example is available in `examples/llm_ws_echo.py`.
