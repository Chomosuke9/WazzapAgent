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
| `/announcement <on\|off>` | Opt this group in or out of owner broadcasts | Group admin |
| `/bot-conf` | Global bot configuration (owner) | Bot owner only |
| `/broadcast <message>` | Send a message to all groups | Bot owner only |
| `/catch` | Mark a message for reprocessing by the bot | Everyone |
| `/compat <auto\|full\|semi\|safe>` | Set interactive-message compatibility | Admin (group), Anyone (private) |
| `/dashboard` | Show usage statistics | Everyone |
| `/debug` | Show debug info | Bot owner only |
| `/download <url>` | Download media or a direct HTTP(S) file | Everyone |
| `/dump` | Build the full LLM context into a .txt file (debugging) | Everyone |
| `/generate <private\|group\|all> <days>` | Generate an activation code | Bot owner only |
| `/help` | Show the command list | Everyone |
| `/idle <n\|min-max\|off>` | Configure the idle trigger | Admin / Owner |
| `/info` | User & chat/group info | Everyone |
| `/join <link>` | Tell the bot to join a group via invite link | Bot owner only |
| `/lid <number>` | Fetch the LID for a number | Owner / own phone |
| `/mode <auto\|prefix\|hybrid>` | View or set the response mode | Admin (group), Anyone (private) |
| `/model [id]` | List or switch the model for this chat | Admin (group), Anyone (private) |
| `/modelcfg` | Configure the default model | Bot owner only |
| `/monitor` | Monitor dashboard across all chats | Bot owner only |
| `/owner-contact` | Send the bot owner contact card | Everyone |
| `/memory [add <text>\|delete <index>]` | Save/list/delete the bot's long-term memory for this chat | Admin/owner (bot self-manages) |
| `/permission` | Check/set moderation permission level | Group admin |
| `/prompt` | View/set/clear the bot prompt | Admin (group), Anyone (private) |
| `/remove-sticker <name>` | Remove a sticker from the catalog | Admin (group), Anyone (private) |
| `/reset` | Reset bot memory | Admin (group), Anyone (private) |
| `/revoke <id\|ids\|unused>` | Revoke activation code(s) from /generate | Bot owner only |
| `/schedule-task <nnHnnM> <prompt>` | Schedule the bot to run a prompt later | Everyone |
| `/daily-task [add <HH:MM> <prompt>\|delete <taskId>]` | List, add, or delete a recurring daily task | Everyone |
| `/group <action>` | Close/open, pin/delete, change description, kick, or mute | Group admin; bot must be admin |
| `/setting` | View/edit per-chat settings | Admin (group), Anyone (private) |
| `/sticker [top#bottom]` | Create a sticker from an image/video | Everyone |
| `/subagent <on\|off>` | Enable/disable the sub-agent per chat | Bot owner only |
| `/trigger <type>` | Check/change prefix-mode triggers | Group admin |
| `/update` | Safely update and restart the bot | Bot owner only |

:::note
Interactive settings are available through **`/setting`**. Text commands such as
`/mode`, `/model`, and `/compat` provide the same core controls on devices where
WhatsApp menus do not render reliably.
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

Use `/add-sticker default <name>` (or `global`) to add to the shared catalog for all chats (owner only).

---

## `/announcement`

Controls whether this group receives messages sent with `/broadcast`. With no
argument, shows the current status.

```
/announcement on
/announcement off
```

The bot owner can also use `/announcement global on|off` or
`/announcement default on|off`.

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

## `/compat`

Controls which interactive-message features the bot uses in this chat:

- `auto` — match the caller's device automatically
- `full` — use all interactive features (best on Android)
- `semi` — avoid list menus (iOS-safe)
- `safe` — use plain text only (works on WhatsApp Web/Desktop)

```
/compat
/compat safe
```

The bot owner can use `/compat global <mode>` or `/compat default <mode>`.

---

## `/dashboard`

Shows usage statistics for this chat.

```
/dashboard
```

Shows:
- Number of messages processed
- Number of responses sent
- Router and main-agent call counts
- Completed sub-agent tasks
- Top monthly users

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

## `/download`

Downloads media from a URL and sends the resulting file to the chat. The
command uses `yt-dlp` for supported media sites, can fall back to a direct
HTTP(S) file download for unsupported URLs, and uses SpotDL for Spotify tracks
when the required dependencies are installed.

```
/download https://example.com/media
/dl https://example.com/file.pdf
```

Temporary files are removed after the send completes. Errors returned to the
chat are bounded and redact URLs that may contain signed query parameters.

---

## `/dump`

Builds the **full LLM context** — system prompt, compact chat information, optional memory/task blocks, history, and the current message — into a `.txt` file and sends it as a document. Handled on the Python side. Useful for debugging the context the bot sees.

```
/dump
```

**Can be used by everyone**, no admin required.

---

## `/generate`

Generates an **activation code** for private chats, groups, or both. The number
of days controls its lifetime; `0` creates a permanent code.

```
/generate private 30
/generate group 0
/generate all 7
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

:::warning
Can only be used by the **bot owner**.
:::

---

## `/lid`

Fetches the **LID** (WhatsApp's internal identifier) for a number. Useful for populating `BOT_OWNER_JIDS`. See [How to get a LID](../installation/how-to-get-lid.md) for the full guide.

```
/lid 628123456789
```

:::warning
Can only be used by the **bot owner** or from your **own phone**.
:::

---

## `/mode`

Shows or sets the response mode for this chat:

- `prefix` — respond only when a configured trigger matches
- `auto` — let LLM1 decide whether to respond
- `hybrid` — try prefix triggers first, then fall back to LLM1

```
/mode
/mode hybrid
```

`auto` and `hybrid` require an LLM1 endpoint. The bot owner can use
`/mode global <mode>` or `/mode default <mode>` for broader scopes.

---

## `/model`

Lists the active LLM2 models or switches this chat to a model by ID. This is the
text fallback for WhatsApp clients that cannot render the model picker.

```
/model
/model gpt-4o
```

---

## `/modelcfg`

Manages available LLM2 models and the default model. The owner can list, add,
edit, remove, and select model configurations, including temperature, token
limits, and vision support.

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

Configures which moderation commands the bot may execute through `/group`.
Delete, mute, and kick are not separate LLM tools.

### View current permission

```txt
/permission
```

### Set permission level

```txt
/permission 0    # No moderation
/permission 1    # Bot can delete messages
/permission 2    # Bot can delete and mute
/permission 3    # Bot can delete, mute, and kick
```

- **Level 0** — Bot only chats, moderation disabled
- **Level 1** — Bot can delete spam or violating messages
- **Level 2** — Bot can delete messages and mute/unmute members
- **Level 3** — Bot can delete, mute/unmute, and kick members

The permission level limits actions initiated by the bot. A human group admin
can use `/group` directly even at level 0, provided the bot is also a group
admin.

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

Use `/remove-sticker default <name>` (or `global`) to remove from the shared catalog (owner only).

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

Revokes activation codes created by [`/generate`](#generate). Run [`/monitor`](#monitor) to see the list of code IDs.

```
/revoke 5            # revoke a single code
/revoke 1,2,3        # revoke several codes at once
/revoke unused       # revoke every code that hasn't been used yet
```

Revoking a code that was **already used** also removes the activation from the chat that used it, so that chat loses access. `/revoke unused` only touches codes that were never used, so no active chat is affected.

:::warning
Can only be used by the **bot owner**.
:::

---

## `/memory`

Gives the bot **long-term memory** for a chat — durable facts and preferences it
should remember across conversations. The bot also manages this itself, saving
things you tell it (e.g. "call me Budi", "always reply in English") and recalling
them on every later turn.

```
/memory                  # list saved memories
/memory add <text>       # save a fact / preference
/memory delete <index>   # remove entry number <index> (from /memory)
```

Mentions work like `/prompt`: tag someone with `@Name` and the link stays correct
even if they later change their display name. Saved memory **persists across
restarts** (max 50 entries per chat, 500 characters each).

Owner-only: `/memory global add|delete …` manages a shared list applied to
**every** chat.

**Usable by group admins and the bot owner** — regular members can't manage it
manually, but the bot maintains it automatically for the chat.

---

## `/schedule-task`

Schedules the bot to **run a prompt later**. Time format `nnHnnM` (e.g. `2H30M` = 2 hours 30 minutes). The schedule **persists across restarts** and fires **once** when the time arrives.

```
/schedule-task 2H30M Remind the group about the meeting
```

**Can be used by everyone**, no admin required.

---

## `/daily-task`

Lists, adds, and deletes recurring daily tasks. The recurring schedule persists
across restarts. Human WhatsApp mentions are stored as stable `@Name (senderRef)`
references, just like `/schedule-task`.

```
/daily-task
/daily-task add 08:00 Remind @Budi to submit the report
/daily-task delete a1b2c3d4
```

The bare command lists only tasks in the current chat, showing each task's
8-character ID, scheduled time, and prompt. Use that ID with `delete`; a task
from another chat cannot be deleted.

The timezone follows `CONTEXT_TIME_UTC_OFFSET_HOURS`, or the server's local
timezone when that setting is empty. **Can be used by everyone.**

---

## `/group`

Group administration is collected under one command family:

```
/group close
/group open
/group pin 7
/group delete
/group description New group description
/group kick @Budi
/group mute @Budi 60
/group mute @Budi 0
```

`pin` and `delete` operate on the message being replied to. Pin duration must be
`1`, `7`, or `30` days; mute duration is in minutes and `0` unmutes the member.
Every action requires the requester to be a group admin (or the bot invoking
itself), and the bot must also be a group admin.

---

## `/setting`

Shows and edits **per-chat settings** through an interactive menu: response mode
(`auto`, `prefix`, or `hybrid`), model, prompt, moderation permission, idle
trigger, activation status, and interactive-message compatibility.

```
/setting
```

:::tip
If a menu or button does not render on your WhatsApp client, use `/mode`,
`/model`, or `/compat safe`. Safe compatibility mode uses plain text only.
:::

---

## `/sticker`

Creates a **WhatsApp sticker** from an image or video. Send an image with the caption `/sticker`, or reply to an image/video with `/sticker`. Add meme text with the format `/sticker top_text#bottom_text`.

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

---

## `/update`

Checks for a safe fast-forward update, applies it, and restarts the supervised
bot processes. Updates that change `compatibilityVersion` are blocked until the
owner reviews and confirms them in **Control Panel → System → Runtime & updates**.

```
/update
```

:::warning
This hidden maintenance command can only be used by the **bot owner**.
:::
