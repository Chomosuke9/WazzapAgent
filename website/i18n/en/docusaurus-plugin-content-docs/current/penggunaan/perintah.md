---
sidebar_position: 3
---

# Command List

All commands start with `/` (forward slash). In groups, most commands can only be used by **admins**. In private chats, all users can use all commands.

## Summary

| Command | Function | Who Can Use |
|---------|----------|-------------|
| `/prompt` | View active prompt | Admin (group), Anyone (private) |
| `/prompt <text>` | Set new prompt | Admin (group), Anyone (private) |
| `/reset` | Reset bot memory | Admin (group), Anyone (private) |
| `/permission` | Check moderation permission level | Group admin |
| `/mode` | Check/change response mode (auto/prefix) | Bot owner only |
| `/trigger` | Check/change prefix-mode triggers | Bot owner only |
| `/dashboard` | Show usage statistics | Everyone |
| `/info` | User & chat/group info | Everyone |
| `/broadcast <message>` | Send to all groups | Bot owner only |

---

## `/prompt`

Sets the **personality, role, and rules** for the bot in this chat.

### View current prompt
```
/prompt
```

### Set a new prompt
```
/prompt <your rules text>
```
**Limit:** maximum 4000 characters.

### Delete prompt (return to default)
```
/prompt -
```
or `/prompt clear` or `/prompt reset`

:::info
Prompts apply **per chat/group**. Settings in group A do not affect group B.
:::

---

## `/reset`

Clears the bot's **memory/conversation history** for this chat.

```
/reset
```

Use when:
- The bot has gone "off track" and its answers don't make sense
- You want to start a fresh conversation from scratch
- After making major prompt changes

---

## `/info`

Displays user and chat/group information.

```
/info
```

Shows:
- **User info:** name, JID (WhatsApp ID), role (member/admin/superadmin/owner)
- **Group info** (if in a group): group name, group ID, member count, bot admin status, bot superadmin status, group description
- **Chat info** (if in private chat): chat type, chat ID

**Can be used by everyone**, no admin required.

---

## `/permission`

Configures **moderation permission levels** for delete/kick actions.

### View current permission

```txt
/permission
```

### Set permission level

```txt
/permission 0    # Delete and kick disabled
/permission 1    # Delete enabled, kick disabled
/permission 2    # Kick enabled, delete disabled
/permission 3    # Delete and kick enabled
```

- **Level 0** — Bot only chats, moderation disabled
- **Level 1** — Bot can delete spam or violating messages
- **Level 2** — Bot can kick troublesome members
- **Level 3** — Bot has full moderation authority

:::info
Permission can only be changed by **group admins**. Settings apply per chat.
:::

---

## `/mode`

Configures how the bot responds in groups: **auto** or **prefix**.

### View current mode

```txt
/mode
```

### Set mode

```txt
/mode auto        # LLM1 decides when to respond
/mode prefix      # Bot only responds when explicitly triggered
```

In private chats, the bot always responds regardless of mode.

---

## `/trigger`

Configures which triggers are active while the bot is in `prefix` mode.

### View current triggers

```txt
/trigger
```

### Set triggers

```txt
/trigger all              # Enable all triggers
/trigger tag,reply        # Only respond to mentions and replies
/trigger tag,reply,name   # Also respond when the bot name is mentioned
```

Available triggers:

- `tag` — bot is mentioned directly
- `reply` — user replies to a bot message
- `name` — bot name is mentioned in text
- `new_member` — a member joins the group

Only the bot owner can change triggers.

---

## `/dashboard`

Shows usage statistics such as message counts, token usage, and model calls.

```txt
/dashboard
```

Can be used by everyone.

---

## `/broadcast`

Sends a message to all groups where the bot is registered.

```
/broadcast <message>
```

Or **reply** to a specific message with `/broadcast` to forward that message to all groups.

:::warning
Can only be used by the **bot owner**. Regular users cannot use this command.
:::
