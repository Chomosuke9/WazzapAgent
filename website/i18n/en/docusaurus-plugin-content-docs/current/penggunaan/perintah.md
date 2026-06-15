---
sidebar_position: 3
---

# Command List

All commands start with `/` (forward slash). In groups, most commands can only be used by **admins**. In private chats, all users can use all commands. Some commands are **bot owner** only.

## Summary

| Command | Function | Who Can Use |
|---------|----------|-------------|
| `/activate <code>` | Activate chat with an activation code | Everyone |
| `/add-sticker <name>` | Add a sticker to the catalog (reply to a sticker) | Admin (group), Anyone (private) |
| `/announcement [message]` | Send an announcement to all members (@all) | Group admin |
| `/bot-conf` | Global bot configuration (owner) | Bot owner only |
| `/broadcast <message>` | Send a message to all groups | Bot owner only |
| `/catch` | Mark a message for reprocessing by the bot | Everyone |
| `/dashboard` | Show usage statistics | Everyone |
| `/debug` | Show debug info | Bot owner only |
| `/generate <prompt>` | Generate an image from a text prompt | Bot owner only |
| `/help` | Show the command list | Everyone |
| `/idle <n\|min-max\|off>` | Configure the idle trigger | Admin / Owner |
| `/info` | User & chat/group info | Everyone |
| `/join <link>` | Tell the bot to join a group via invite link | Everyone |
| `/modelcfg` | Configure the default model | Bot owner only |
| `/monitor` | Monitor dashboard across all chats | Bot owner only |
| `/owner-contact` | Send the bot owner contact card | Everyone |
| `/permission` | Check/set moderation permission level | Group admin |
| `/prompt` | View/set/clear the bot prompt | Admin (group), Anyone (private) |
| `/remove-sticker <name>` | Remove a sticker from the catalog | Admin (group), Anyone (private) |
| `/reset` | Reset bot memory | Admin (group), Anyone (private) |
| `/revoke [n]` | Revoke the group invite link | Bot owner only |
| `/setting` | View/edit per-chat settings (incl. response mode) | Admin (group), Anyone (private) |
| `/sticker [bottom#top]` | Create a sticker from an image/video | Everyone |
| `/subagent <on\|off>` | Enable/disable the sub-agent per chat | Bot owner only |
| `/trigger <type>` | Check/change prefix-mode triggers | Group admin |

:::note
Response mode (auto/prefix) **no longer** uses the `/mode` command. It is now configured through the interactive **`/setting`** menu.
:::

---

## `/activate`

Activates this chat using an **activation code** provided by the owner. Once activated, the bot will respond to messages in this chat.

```
/activate WA-ABC12345
```

---

## `/add-sticker`

Adds a sticker to the **bot catalog** by replying to a sticker and naming it. The bot can then send stickers from this catalog via the `send_sticker` tool.

```
/add-sticker cute cat
```

Use `/add-sticker global <name>` to add to the global catalog for all chats (owner only).

---

## `/announcement`

Sends an announcement message to all group members with an `@all` mention. With no argument, shows the current on/off status.

```
/announcement Meeting tonight at 8 PM
```

---

## `/bot-conf`

**Global** bot configuration (applies to all chats): change the activation message, set the base system prompt, or enable/disable require-activation.

```
/bot-conf
```

:::warning
Can only be used by the **bot owner**.
:::

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

---

## `/catch`

Marks the message you reply to so it can be **reprocessed** by the bot. Useful when the bot needs to re-analyze a specific message.

```
/catch
```

---

## `/dashboard`

Shows usage statistics for this chat.

```
/dashboard
```

Shows:
- Number of messages processed
- Number of responses sent
- Tokens used (LLM1 & LLM2)
- Average response time
- Other info depending on configuration

**Can be used by everyone**, no admin required.

---

## `/debug`

Shows **debug** information (for development/diagnostics).

```
/debug
```

:::warning
Can only be used by the **bot owner**.
:::

---

## `/generate`

Generates an **image** from a text prompt.

```
/generate astronaut cat wearing a helmet
```

:::warning
Can only be used by the **bot owner**.
:::

---

## `/help`

Shows the available **command list**. Aliases: `/menu`, `/list`.

```
/help
```

---

## `/idle`

Configures the **idle trigger**: the bot chimes in after a number of messages pass without a reply.

```
/idle 5          # after exactly 5 messages
/idle 5-10       # random within a range
/idle off        # disable
```

---

## `/info`

Displays user and chat/group information.

```
/info
```

Shows:
- **User info:** name, JID (WhatsApp ID), role (member/admin/superadmin/owner)
- **Group info** (if in a group): group name, group ID, member count, bot admin status, bot superadmin status, group description
- **Chat info** (if in private chat): chat type, chat ID, activation status

**Can be used by everyone**, no admin required.

---

## `/join`

Tells the bot to **join a group** via an invite link. The bot joins under its own account.

```
/join https://chat.whatsapp.com/AbCdEfGhIjK
```

---

## `/modelcfg`

Configures the **default model** for LLM2 (via an interactive menu).

```
/modelcfg
```

:::warning
Can only be used by the **bot owner**.
:::

---

## `/monitor`

Shows a compact **dashboard monitor** across all chats.

```
/monitor
```

:::warning
Can only be used by the **bot owner**.
:::

---

## `/owner-contact`

Sends the **bot owner contact card** to this chat. The owner can set the contact sent with `/owner-contact set <number>`.

```
/owner-contact
```

---

## `/permission`

Configures **moderation permission levels** for delete/mute/kick actions.

### View current permission

```txt
/permission
```

### Set permission level

```txt
/permission 0    # No moderation
/permission 1    # Bot can delete messages
/permission 2    # + mute members
/permission 3    # + kick members (full moderation)
```

- **Level 0** — Bot only chats, moderation disabled
- **Level 1** — Bot can delete spam or violating messages
- **Level 2** — Bot can mute troublesome members
- **Level 3** — Bot has full moderation authority (including kick)

:::info
Permission can only be changed by **group admins**. Settings apply per chat.
:::

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
/prompt clear
```

:::info
Prompts apply **per chat/group**. Settings in group A do not affect group B.
:::

---

## `/remove-sticker`

Removes a sticker from the **bot catalog** by name.

```
/remove-sticker cute cat
```

Use `/remove-sticker global <name>` to remove from the global catalog (owner only).

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

Use `/reset global` to clear memory across all chats at once (owner only).

---

## `/revoke`

Revokes the current **group invite link** and creates a fresh one. Useful when the old link has leaked. Optionally repeat several times.

```
/revoke 3
```

:::warning
Can only be used by the **bot owner**.
:::

---

## `/setting`

Shows and edits **per-chat settings** through an interactive menu: response mode (auto/prefix), model, permission level, idle trigger, and activation status.

```
/setting
```

:::info
**Response mode** (auto/prefix) is now configured here, replacing the old `/mode` command.
:::

---

## `/sticker`

Creates a **WhatsApp sticker** from an image or video. Send an image with the caption `/sticker`, or reply to an image/video with `/sticker`. Add meme text with the format `/sticker bottom_text#top_text`.

```
/sticker so me#when monday arrives
```

---

## `/subagent`

Enables or disables the **sub-agent** for this chat. The sub-agent lets the bot delegate complex tasks to an external service (WazzapSubAgents). Requires `SUBAGENT_URL` to be configured.

```
/subagent on
```

:::warning
Can only be used by the **bot owner**.
:::

---

## `/trigger`

Configures which **triggers** are active while the bot is in `prefix`/`hybrid` mode.

### View current triggers

```txt
/trigger
```

### Set triggers

```txt
/trigger reply on         # Respond when replied to
/trigger tag on           # Respond when mentioned
```

Available triggers:

- `tag` — bot is mentioned directly (e.g. `@Vivy`)
- `tagall` — the message uses `@all`
- `reply` — user replies to a bot message
- `name` — bot name is mentioned in text (case-insensitive)
- `join` — a new member joins the group

:::note
Only applies in **prefix/hybrid** mode. In auto mode, triggers are ignored.
:::
