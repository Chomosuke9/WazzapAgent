# 03 - Commands, Aliases, Permissions

## Command category groups

| Category | Commands |
|----------|----------|
| **Configuration** | `/trigger`, `/prompt`, `/modelcfg`, `/setting`, `/subagent`, `/idle`, `/bot-conf` |
| **Moderation** | `/permission` |
| **Information** | `/help`, `/info`, `/debug`, `/dashboard`, `/monitor`, `/owner-contact` |
| **Management** | `/reset`, `/broadcast`, `/join`, `/revoke`, `/announcement`, `/generate`, `/activate` |
| **Stickers** | `/sticker`, `/add-sticker`, `/remove-sticker` |
| **Utility** | `/catch`, `/dump` |

## Canonical command list

The following commands are registered as per-command handler modules under `src/wa/commands/*.ts` (parsed by `src/wa/commands/parseCommand.ts` via the `COMMAND_ALIASES` map) and dispatched by the `CommandRegistry` in `src/wa/command/CommandRegistry.ts`:

| Command | Alias(es) | Description |
|---------|-----------|-------------|
| `help` | `helps`, `menu`, `list` | Show command list |
| `activate` | — | Activate chat with activation code |
| `generate` | — | Generate activation code (owner only) |
| `monitor` | — | Show monitor dashboard (owner only) |
| `revoke` | — | Revoke activation code (owner only) |
| `prompt` | `prompts` | Set/view/clear per-chat prompt override |
| `reset` | `resets` | Clear chat history in Python |
| `permission` | `permissions` | Set moderation permission level (0–3) |
| `trigger` | `triggers` | Set prefix triggers for prefix/hybrid mode |
| `dashboard` | `dashboards` | Display usage statistics |
| `broadcast` | `broadcasts` | Send broadcast to all groups (owner only) |
| `info` | `infos` | Show user/chat/group info |
| `debug` | `debugs` | Send test interactive payload |
| `join` | `joins` | Join a group via invite link |
| `sticker` | `stickers` | Create sticker from image/video |
| `add-sticker` | `addsticker`, `addstickers`, `add-stickers` | Add sticker to catalog |
| `remove-sticker` | `removesticker`, `remove-stickers`, `removestickers` | Remove sticker from catalog |
| `modelcfg` | `modelcfgs` | Configure model list (owner only) |
| `setting` | `settings` | Interactive settings menu |
| `catch` | `catches` | Catch/forward quoted message |
| `owner-contact` | — | Show bot owner contact info |
| `subagent` | `subagents` | Toggle sub-agent per chat |
| `idle` | — | Configure idle trigger range |
| `announcement` | `announcements` | Toggle announcement broadcast opt-in per group |
| `bot-conf` | `botconf` | Owner-only bot-wide config (activation-msg, prompt-override, require-activation) |

Total: 25 canonical commands.

## Singular/plural aliases

The command parser normalises aliases to the canonical form. Every canonical command
has at least a singular/plural pair. Examples:

| Input | Canonical |
|-------|-----------|
| `/setting`, `/settings` | `setting` |
| `/prompt`, `/prompts` | `prompt` |
| `/dashboard`, `/dashboards` | `dashboard` |
| `/addsticker`, `/addstickers` | `add-sticker` |

## Permission model

### Activation gate

When `REQUIRE_ACTIVATION=true` (env var), only two commands are exempt:

| Command | Reason |
|---------|--------|
| `/info` | Allows the user to see bot info and understand they need to activate |
| `/activate <code>` | The only way to activate a chat |

All other commands are blocked for unactivated chats. The gate is enforced at
two levels:
1. **Node.js** (`src/wa/command/CommandRegistry.ts`, `dispatchCommand`): checks `ACTIVATION_EXEMPT_COMMANDS` set before dispatch.
2. **Python bridge** (`main.py`): drops `incoming_message` payloads from unactivated
   chats before they enter the debounce/batch pipeline.

Expired activations show an expiry notification message once.

### Owner-only commands

The following commands are restricted to JIDs listed in `BOT_OWNER_JIDS`:

| Command | Reason |
|---------|--------|
| `/broadcast` | Sends a message to every group — destructive if abused |
| `/generate` | Generates activation codes for chat activation |
| `/revoke` | Revokes activation code(s) by ID, a comma list (`1,2,3`), or `unused` |
| `/monitor` | Shows sensitive dashboard data |
| `/modelcfg` | Manages the global model registry |
| `/debug` | Sends test interactive payloads; exposes internal state |

The owner check is performed in each handler's guard clause (dispatched via
`src/wa/command/CommandRegistry.ts`) before the handler runs. Non-owner senders receive an
Indonesian-language rejection message.

### Admin-only commands in groups

In group chats, the following commands require sender to be a group admin (or bot owner):

| Command | Admin required |
|---------|:--------------:|
| `/trigger` | ✅ |
| `/prompt` | ✅ |
| `/reset` | ✅ |
| `/permission` | ✅ |
| `/setting` | ✅ |
| `/subagent` | ✅ (owner only) |
| `/idle` | ✅ |
| `/announcement` | ✅ |
| `/add-sticker` | ✅ |
| `/remove-sticker` | ✅ |
| `/sticker` | ❌ (anyone can use) |

Admin status is determined by `senderIsAdmin` in the context object, which comes
from Baileys group participant role metadata.

### General access rules

- **Private chat**: Most commands are allowed freely.
- **Group chat**: Configuration commands require admin or owner role (see table above).
- **Owner-only commands** (table above) are restricted to bot owner regardless of
  chat type.

### Moderation level (`/permission`)

| Level | Label | Moderation tools available |
|:-----:|-------|---------------------------|
| 0 | Moderation forbidden | None |
| 1 | Delete allowed | `delete_messages` |
| 2 | Delete + mute allowed | `delete_messages`, `mute_member` |
| 3 | Delete + mute + kick allowed | `delete_messages`, `mute_member`, `kick_members` |

> **Note**: For levels > 0, the bot must have admin role in the group. If the bot
> is demoted, permission is automatically reset to 0.

### Available LLM2 tools by permission level

| Tool | Level 0 | Level 1 | Level 2 | Level 3 |
|------|:-------:|:-------:|:-------:|:-------:|
| `reply_message` | ✅ | ✅ | ✅ | ✅ |
| `react_to_message` | ✅ | ✅ | ✅ | ✅ |
| `send_sticker` | ✅ | ✅ | ✅ | ✅ |
| `send_quiz` | ✅ | ✅ | ✅ | ✅ |
| `delete_messages` | ❌ | ✅ | ✅ | ✅ |
| `mute_member` | ❌ | ❌ | ✅ | ✅ |
| `kick_members` | ❌ | ❌ | ❌ | ✅ |
| `execute_subtask` | ✅ (if sub-agent enabled) | ✅ | ✅ | ✅ |

## Command processing

### Entry points

Commands can reach the system through three paths:

1. **Human-typed in WhatsApp** — the primary path. Baileys fires `messages.upsert`,
   `src/account/baileysFactory.ts` runs two listeners sequentially:
   - **Listener 1** (`src/wa/command/CommandRegistry.ts`): handles the command immediately, sends
     the reply on WhatsApp, and returns `true`.
   - **Listener 2** (`src/wa/inbound.ts` → WS `incoming_message`): always sets
     `commandHandled: true` for any slash command, then forwards the payload to
     Python strictly for history/context tracking.

2. **LLM2-triggered via `run_command` action** — the LLM2 can bundle a `command`
   parameter in the `reply_message` tool call. Python emits a `run_command` action
   over WS, and Node's `src/wa/runCommand.ts` synthesises a fake `msg` object
   (including quoted message support via `contextMsgId`) and dispatches it through
   the same command path. The command runs silently — no text is posted
   to the WhatsApp chat.

3. **Interactive menu button taps** — quick-reply buttons and list selections from
   interactive messages (settings menu, quiz) arrive as plain text replies.
   Node's inbound handler distinguishes quiz replies (tracked via `quizMessageIds`
   set in `src/wa/domain/caches.ts`) from settings menu replies. Quiz replies are forwarded to
   Python for LLM processing; settings menu commands are resolved in Node directly.

### Where each command is handled

| Command | Node (`command/CommandRegistry.ts`) | Python | Notes |
|---------|:--------------------------:|:------------------:|-------|
| `help` | ✅ | — | Sends help text directly |
| `activate` | ✅ | — | Updates activation DB record |
| `info` | ✅ | — | Builds response from group/participant cache |
| `debug` | ✅ (owner) | — | Sends a test interactive payload |
| `join` | ✅ | — | Calls `sock.groupAcceptInvite` |
| `catch` | ✅ | — | Forwards quoted message to sender |
| `owner-contact` | ✅ | — | Shows configured owner contact info |
| `subagent` | ✅ | — | Toggles sub-agent flag; sends WS event |
| `idle` | ✅ | — | Updates idle trigger range in DB |
| `announcement` | ✅ | — | Toggles announcement broadcast opt-in per group |
| `setting` | ✅ | — | Sends interactive settings menu |
| `add-sticker` | ✅ | — | Requires WhatsApp socket for media download |
| `remove-sticker` | ✅ | — | Removes sticker from catalog DB |
| `sticker` | ✅ | — | Node path uses sharp + ffmpeg |
| `monitor` | ✅ (owner) | — | Shows dashboard monitor |
| `revoke` | ✅ (owner) | — | Revoke activation code |
| `generate` | ✅ (owner) | — | Generate activation code |
| `modelcfg` | ✅ (owner) | — | Manages global model registry |
| `broadcast` | ✅ (owner) | — | Sends message to all groups |
| `prompt` | ✅ | —¹ | Node handles reply; sends `invalidate_chat_settings` WS event |
| `reset` | ✅ | —¹ | Node handles reply; sends `clear_history` WS event |
| `permission` | ✅ | —¹ | Node handles reply; sends `invalidate_chat_settings` WS event |
| `trigger` | ✅ | —¹ | Node handles reply; sends `invalidate_chat_settings` WS event |
| `dashboard` | ✅ | —¹ | Node builds dashboard text from stats DB |
| `dump` | — | ✅ | Python builds full LLM context and sends as `.txt` attachment |

> ¹ Slash commands are dispatched entirely Node-side through the `CommandRegistry`
> (`src/wa/command/CommandRegistry.ts`); Python never parses or handles them
> (`incoming_message` always carries `commandHandled=true`, see `src/wa/inbound.ts`).
> For these commands Node handles the reply and emits the matching reliable
> control event (`clear_history`, `invalidate_chat_settings`, …) so the bridge
> keeps its caches/history in sync. `/dump` is the only command produced
> Python-side, because it needs the full assembled LLM context.

### Silent LLM2 command execution

When LLM2 wants to execute a command as a side-effect of a text reply (e.g., create a
sticker from a quoted image and explain what it did), it uses the `reply_message` tool's
`command` and `command_context_msg_id` fields:

```
LLM2 reply_message tool call:
  context_msg_id: "000142"
  text: "Here's your sticker!"
  command: "/sticker Fun#Times"
  command_context_msg_id: "000142"
```

Python detects the non-null `command` field, emits a `run_command` WS action, and
waits for the `action_ack` before appending the command result to the LLM history.
The command runs through `src/wa/runCommand.ts` which builds a fake `msg` object with
`fromMe: true` and `senderIsOwner: true` (the bot is always privileged for
self-triggered commands).

## Global variants

Several commands accept a `global` keyword as the first argument to apply the
setting to all chats (existing and future) instead of just the current chat.
Only the bot owner can use the `global` variant.

| Command | Global usage | Source file |
|---------|-------------|-------------|
| `/prompt` | `/prompt global <text>` / `/prompt global clear` | `src/wa/commands/prompt.ts` |
| `/permission` | `/permission global <0-3>` | `src/wa/commands/permission.ts` |
| `/idle` | `/idle global <min-max>` / `/idle default ...` / `/idle global off` | `src/wa/commands/idle.ts` |
| `/subagent` | `/subagent global on\|off` / `/subagent default on\|off` | `src/wa/commands/subagent.ts` |
| `/bot-conf` | owner-only: `activation-msg`, `prompt-override`, `require-activation` | `src/wa/commands/bot-conf.ts` |
| `/announcement` | `/announcement global on\|off` / `/announcement default on\|off` | `src/wa/commands/announcement.ts` |

## Command summary table

| Command | Access | Where handled | Description |
|---------|--------|:-------------:|-------------|
| `/help` | Everyone | Node | Show command list |
| `/info` | Everyone | Node | Show user/chat/group info |
| `/activate <code>` | Everyone | Node | Activate chat with activation code |
| `/debug` | Owner only | Node | Send test interactive payload |
| `/catch` | Everyone | Node | Catch/forward quoted message |
| `/owner-contact` | Everyone | Node | Show bot owner contact info |
| `/join <link>` | Everyone | Node | Join group via invite link |
| `/dashboard` | Everyone | Node | Display usage statistics |
| `/dump` | Everyone | Python | Export full LLM context as .txt |
| `/sticker [upper#lower]` | Everyone | Node + Python | Create sticker from image/video |
| `/trigger <type>` | Admin/owner | Node | Set prefix triggers |
| `/prompt [text\|clear]` | Admin/owner | Node | Set/view/clear per-chat prompt |
| `/reset` | Admin/owner | Node | Clear chat history |
| `/permission <0-3>` | Admin/owner | Node | Set moderation permission level |
| `/setting` | Admin/owner | Node | Interactive settings menu |
| `/subagent <on\|off>` | Owner only | Node | Toggle sub-agent per chat |
| `/idle <min-max>` | Admin/owner | Node | Configure idle trigger range |
| `/announcement <on\|off>` | Admin/owner | Node | Toggle announcement broadcast opt-in per group |
| `/add-sticker <name>` | Admin/owner | Node | Add sticker to catalog |
| `/remove-sticker <name>` | Admin/owner | Node | Remove sticker from catalog |
| `/modelcfg` | Owner only | Node | Configure model list |
| `/bot-conf` | Owner only | Node | Bot-wide config (activation-msg, prompt-override, require-activation) |
| `/broadcast <text>` | Owner only | Node | Broadcast to all groups |
| `/generate <type> <days>` | Owner only | Node | Generate activation code |
| `/revoke` | Owner only | Node | Revoke activation code |
| `/monitor` | Owner only | Node | Show monitor dashboard |
