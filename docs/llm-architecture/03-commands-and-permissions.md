# 03 - Commands, Aliases, Permissions

## Command category groups

| Category | Commands |
|----------|----------|
| **Configuration** | `/mode`, `/trigger`, `/prompt`, `/model`, `/modelcfg`, `/setting`, `/subagent`, `/idle` |
| **Moderation** | `/permission` |
| **Information** | `/help`, `/info`, `/debug`, `/dashboard`, `/monitor`, `/owner-contact`, `/group-status` |
| **Management** | `/reset`, `/broadcast`, `/join`, `/revoke`, `/announcement`, `/generate`, `/activate` |
| **Stickers** | `/sticker`, `/add-sticker`, `/remove-sticker` |
| **Utility** | `/catch`, `/dump` |

## Canonical command list

The following commands are registered as per-command handler modules under `src/wa/command/*.ts` (parsed by `src/wa/command/parseCommand.ts` via the `COMMAND_ALIASES` map) and dispatched by the `CommandRegistry` in `src/wa/commands/CommandRegistry.ts`:

| Command | Alias(es) | Description |
|---------|-----------|-------------|
| `help` | `helps` | Show command list |
| `activate` | — | Activate chat with activation code |
| `generate` | — | Generate activation code (owner only) |
| `monitor` | — | Show monitor dashboard (owner only) |
| `revoke` | — | Revoke activation code (owner only) |
| `prompt` | `prompts` | Set/view/clear per-chat prompt override |
| `reset` | `resets` | Clear chat history in Python |
| `permission` | `permissions` | Set moderation permission level (0–3) |
| `mode` | `modes` | Set response mode (auto/prefix/hybrid) |
| `trigger` | `triggers` | Set prefix triggers for prefix/hybrid mode |
| `dashboard` | `dashboards` | Display usage statistics |
| `broadcast` | `broadcasts` | Send broadcast to all groups (owner only) |
| `info` | `infos` | Show user/chat/group info |
| `debug` | `debugs` | Send test interactive payload |
| `join` | `joins` | Join a group via invite link |
| `sticker` | `stickers` | Create sticker from image/video |
| `add-sticker` | `addsticker`, `addstickers`, `add-stickers` | Add sticker to catalog |
| `remove-sticker` | `removesticker`, `remove-stickers`, `removestickers` | Remove sticker from catalog |
| `model` | `models` | Select LLM2 model per chat |
| `modelcfg` | `modelcfgs` | Configure model list (owner only) |
| `setting` | `settings` | Interactive settings menu |
| `group-status` | `gs` | Show/edit group description |
| `catch` | `catches` | Catch/forward quoted message |
| `owner-contact` | — | Show bot owner contact info |
| `subagent` | `subagents` | Toggle sub-agent per chat |
| `idle` | — | Configure idle trigger range |
| `announcement` | `announcements` | Toggle announcement broadcast opt-in per group |
| `dump` | — | Export full LLM context as .txt attachment |

Total: 28 canonical commands.

## Singular/plural aliases

The command parser normalises aliases to the canonical form. Every canonical command
has at least a singular/plural pair. Examples:

| Input | Canonical |
|-------|-----------|
| `/setting`, `/settings` | `setting` |
| `/model`, `/models` | `model` |
| `/prompt`, `/prompts` | `prompt` |
| `/dashboard`, `/dashboards` | `dashboard` |
| `/addsticker`, `/addstickers` | `add-sticker` |
| `/gs` | `group-status` |

## Permission model

### Activation gate

When `REQUIRE_ACTIVATION=true` (env var), only two commands are exempt:

| Command | Reason |
|---------|--------|
| `/info` | Allows the user to see bot info and understand they need to activate |
| `/activate <code>` | The only way to activate a chat |

All other commands are blocked for unactivated chats. The gate is enforced at
two levels:
1. **Node.js** (`src/wa/commands/CommandRegistry.ts`, `dispatchCommand`): checks `ACTIVATION_EXEMPT_COMMANDS` set before dispatch.
2. **Python bridge** (`main.py`): drops `incoming_message` payloads from unactivated
   chats before they enter the debounce/batch pipeline.

Expired activations show an expiry notification message once.

### Owner-only commands

The following commands are restricted to JIDs listed in `BOT_OWNER_JIDS`:

| Command | Reason |
|---------|--------|
| `/broadcast` | Sends a message to every group — destructive if abused |
| `/generate` | Generates activation codes for chat activation |
| `/revoke` | Revokes an activation code by ID |
| `/monitor` | Shows sensitive dashboard data |
| `/modelcfg` | Manages the global model registry |
| `/debug` | Sends test interactive payloads; exposes internal state |

The owner check is performed in each handler's guard clause (dispatched via
`src/wa/commands/CommandRegistry.ts`) before the handler runs. Non-owner senders receive an
Indonesian-language rejection message.

### Admin-only commands in groups

In group chats, the following commands require sender to be a group admin (or bot owner):

| Command | Admin required |
|---------|:--------------:|
| `/mode` | ✅ |
| `/trigger` | ✅ |
| `/prompt` | ✅ |
| `/reset` | ✅ |
| `/permission` | ✅ |
| `/setting` | ✅ |
| `/subagent` | ✅ (owner only) |
| `/idle` | ✅ |
| `/announcement` | ✅ |
| `/group-status` | ✅ |
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
   `src/wa/connection.ts` runs two listeners sequentially:
   - **Listener 1** (`src/wa/commands/CommandRegistry.ts`): handles the command immediately, sends
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

| Command | Node (`commands/CommandRegistry.ts`) | Python (`main.py`) | Notes |
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
| `group-status` | ✅ | — | Shows/edits group description |
| `setting` | ✅ | — | Sends interactive settings menu |
| `model` | ✅ | — | Sends interactive model selection menu |
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
| `mode` | ✅ | —¹ | Node handles reply; sends `invalidate_chat_settings` WS event |
| `trigger` | ✅ | —¹ | Node handles reply; sends `invalidate_chat_settings` WS event |
| `dashboard` | ✅ | —¹ | Node builds dashboard text from stats DB |
| `dump` | — | ✅ | Python builds full LLM context and sends as `.txt` attachment |

> ¹ Python's `commands.py` contains handlers for `prompt`/`reset`/`permission`/
> `mode`/`trigger`/`dashboard`/`help`, but `handle_command()` is never invoked from
> `main.py` because Node always sets `commandHandled=true` (see `src/wa/inbound.ts`).
> These are effectively dead code. Python does handle `/reset` (memory clear) and
> `/dump` (context export) inline in `main.py` (lines 1116, 1145) before the
> `commandHandled` check.

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
| `/mode` | `/mode global auto\|prefix\|hybrid` | `src/wa/command/mode.ts` |
| `/prompt` | `/prompt global <text>` / `/prompt global clear` | `src/wa/command/prompt.ts` |
| `/permission` | `/permission global <0-3>` | `src/wa/command/permission.ts` |
| `/idle` | `/idle global <min-max>` / `/idle global off` | `src/wa/command/idle.ts` |
| `/subagent` | `/subagent global on\|off` | `src/wa/command/subagent.ts` |
| `/model` | `/model global <modelId>` | `src/wa/command/model.ts` |
| `/announcement` | `/announcement global on\|off` | `src/wa/command/announcement.ts` |

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
| `/mode <auto\|prefix\|hybrid>` | Admin/owner | Node | Set response mode |
| `/trigger <type>` | Admin/owner | Node | Set prefix triggers |
| `/prompt [text\|clear]` | Admin/owner | Node | Set/view/clear per-chat prompt |
| `/reset` | Admin/owner | Node | Clear chat history |
| `/permission <0-3>` | Admin/owner | Node | Set moderation permission level |
| `/setting` | Admin/owner | Node | Interactive settings menu |
| `/group-status` | Admin/owner | Node | Show/edit group description |
| `/subagent <on\|off>` | Owner only | Node | Toggle sub-agent per chat |
| `/idle <min-max>` | Admin/owner | Node | Configure idle trigger range |
| `/announcement <on\|off>` | Admin/owner | Node | Toggle announcement broadcast opt-in per group |
| `/add-sticker <name>` | Admin/owner | Node | Add sticker to catalog |
| `/remove-sticker <name>` | Admin/owner | Node | Remove sticker from catalog |
| `/model` | Admin/owner | Node | Select LLM2 model per chat |
| `/modelcfg` | Owner only | Node | Configure model list |
| `/broadcast <text>` | Owner only | Node | Broadcast to all groups |
| `/generate <type> <days>` | Owner only | Node | Generate activation code |
| `/revoke` | Owner only | Node | Revoke activation code |
| `/monitor` | Owner only | Node | Show monitor dashboard |
