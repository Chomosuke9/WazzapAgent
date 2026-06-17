---
sidebar_position: 4
---

# Permission System (Moderation Permissions)

Permissions control how much authority the bot has in managing the group.

## Permission Levels

| Level | Delete Messages | Mute Members | Kick Members | Description |
|-------|:--------------:|:------------:|:------------:|-------------|
| **0** | ❌ | ❌ | ❌ | Default. Bot only chats. |
| **1** | ✅ | ❌ | ❌ | Bot can delete violating messages. |
| **2** | ✅ | ✅ | ❌ | Bot can delete + mute members. |
| **3** | ✅ | ✅ | ✅ | Bot has full moderation authority (delete + mute + kick). |

## How to Set

```
/permission       ← check current level
/permission 0     ← disable all moderation
/permission 1     ← enable message deletion only
/permission 2     ← enable delete + mute
/permission 3     ← enable delete + mute + kick
```

:::note
Can only be used in **groups**. Only **group admins** can change permissions.
:::

## When to Use Which Level?

- **Level 0** — Bot is only used for chatting, no moderation needed
- **Level 1** — Group has lots of spam links/toxic messages but you don't want anyone kicked
- **Level 2** — You need to delete messages + mute disruptive members
- **Level 3** — Group needs full moderation (delete + mute + kick)

## Recommended Workflow

1. **Make the bot an admin** first
2. **Set a moderator prompt** (see [Prompt Examples](/penggunaan/contoh-prompt))
3. **Test in a testing group** starting from level 1
4. Increase the level once you're confident the bot behaves correctly

:::danger WARNING
**KICK AND DELETE ARE HIGHLY DESTRUCTIVE CAPABILITIES.**

A misconfigured bot can accidentally kick members or delete important messages.

**REQUIRED:** Test in a testing group first before enabling in a real group. Do not immediately set permission 3.
:::
