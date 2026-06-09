# 00 - System Overview

## Core components

### 1) Node Gateway (`src/`)
Primary responsibilities:
- WhatsApp connection via Baileys v7 socket.
- Incoming message parsing + media normalization (messageParser.js, mediaHandler.js).
- Assigning contextMsgId (6-digit per-chat sequence) and senderRef to each inbound message (identifiers.js).
- Slash command handling: most commands are dispatched and executed here (commandHandler.js + `src/wa/command/`).
- Interactive message construction (NativeFlow buttons, carousels, lists) via relayMessage with additionalNodes.
- Sending `incoming_message` events to the Python bridge over WebSocket.
- Executing actions received from Python (`send_message`, `delete_message`, `kick_member`, `run_command`, etc.).
- Tracking quiz interactive message IDs (`quizMessageIds` set in caches.js) so that quiz replies are correctly attributed.

### 2) Python Bridge (`python/bridge/`)
Primary responsibilities:
- Receiving `incoming_message` payloads from Node via WebSocket.
- Batching/debouncing per chat, trigger filtering, LLM1 routing, and LLM2 response generation.
- Extracting tool calls from LLM2 output and converting them to action commands.
- Sending action commands back to Node over WebSocket.
- Writing dashboard statistics (in-memory buffer + periodic DB flush).
- Managing per-chat settings (prompt, mode, triggers, permission level) and moderation state (mutes).
- Handling Python-side slash commands (`/reset`, `/dump`, `/sticker`).

### 3) Sub-agent System (`python/bridge/subagent/`)
A sandboxed task-execution subsystem that lets LLM2 delegate complex work (file processing, code execution, web scraping, attachment generation) to an external HTTP agent:
- **`execute_subtask` tool** — LLM2 calls this with an instruction and optional attached files. The bridge submits the task to a sub-agent webhook endpoint.
- **SubTaskTracker** (`subagent/tracker.py`) — tracks active sessions per chat, prevents duplicate submissions, provides context to LLM2 about running tasks (steering), and handles cleanup on `/reset`.
- **Webhook server** (`subagent/webhook_server.py`) — receives task progress/failure/completion callbacks from the sub-agent, deduplicates retries, and feeds results back into the message pipeline for LLM2 re-invocation.
- **Correction re-dispatch** — when a sub-agent result is unsatisfactory (missing format, wrong output), LLM2 can call `execute_subtask` again with a revised instruction. The tracker routes it as a correction to the same session.

### 4) Idle Trigger
A probabilistic mechanism that occasionally fires the bot's response even when no trigger conditions are met (e.g., in prefix mode without the prefix, or when LLM1 skips a message). This prevents the bot from going completely silent in active groups:
- Per-chat configuration: `idle_trigger_min` and `idle_trigger_max` (stored in `chat_settings`).
- On each non-triggered or LLM1-skipped message, an internal counter increments.
- When `_should_idle_trigger()` is called, it computes `P = 1.0 / (max_val - msg_count + 1)` — so the probability rises with activity.
- Once fired, the counter resets and the message is routed to LLM2 normally.

## Data flow (detailed)
1. User sends a message on WhatsApp.
2. Baileys receives the `messages.upsert` event on the Node gateway.
3. Node unwraps the raw Baileys message (messageParser.js — handles viewOnce, interactive, buttons, ephemeral).
4. Node assigns a `contextMsgId` (per-chat 6-digit counter) and `senderRef` (deterministic short hash per sender) via identifiers.js.
5. Node processes any slash commands first (commandHandler.js). If the message is a recognized slash command, it is handled entirely in Node and never forwarded.
6. If not handled, Node sends an `incoming_message` payload to the Python bridge over WebSocket (wsClient.send() — best-effort).
7. Python places the message in a per-chat pending buffer. Mute enforcement runs first — if the sender is muted, the message is deleted instantly without further processing.
8. After the debounce window (or immediately for private chats / prefix-matched messages), Python builds a burst payload.
9. Python runs trigger filtering: in prefix/hybrid mode, only messages matching the configured prefix proceed; in auto mode, all group messages are candidates. Private chats always proceed.
10. Python checks the idle trigger — if no prefix matched or LLM1 would skip, the idle counter may promote the message anyway.
11. If the burst passes gating, Python runs **LLM1** (decision router). LLM1 determines: respond, express-only (emoji/sticker), or skip. If LLM1 returns skip and no idle trigger fires, the burst is dropped. LLM1 is skipped in private chats.
12. If LLM1 decides to respond (or is skipped via empty endpoint), Python runs **LLM2** (response generator). LLM2 produces text + optional tool calls.
13. Python extracts actions from LLM2's output: `reply_message`, `delete_message`, `mute_member`, `kick_members`, `execute_subtask`, etc. (messaging/actions.py).
14. Python sends action commands to Node via WebSocket (gateway.py).
15. Node dispatches each action on WhatsApp (send message, react, delete, kick, etc.) and sends `action_ack` / `error` back to Python.
16. Python logs the ack, updates the reply dedup cache, and optionally re-invokes LLM2 if a sub-agent result arrived.

## WebSocket reliability
The Node-to-Python WS connection uses two send modes:
- **`send()`** — best-effort. Drops the message silently if the WS is not open. Used for transient data that will be superseded: `incoming_message` events, presence updates.
- **`sendReliable()`** — queues the message in memory when disconnected and flushes on reconnect. Used for control events that must not be lost: `whatsapp_status`, `clear_history`, `invalidate_llm2_model`, `invalidate_default_model`, `set_llm2_model`, `invalidate_chat_settings`, `set_subagent_enabled`.

The Python bridge uses the `websockets` library's built-in ping/pong via `ping_interval=20, ping_timeout=20` (`python/bridge/main.py:3135-3136`). Node reconnects with exponential backoff + jitter on disconnect; the reconnect attempt counter resets after the socket stays open for a grace period.

## Command design
Slash commands are split across both sides:

**Node-side** (most commands): `/help`, `/info`, `/debug`, `/join`, `/sticker`, `/broadcast`, `/mode`, `/trigger`, `/setting`, `/model`, `/modelcfg`, `/groupStatus`, `/catch`, `/dashboard`, `/permission` (all executed in `src/wa/commandHandler.js` with per-command modules in `src/wa/command/`). Aliases are normalized via `src/wa/command/parseCommand.js` (e.g., `/models` → `model`, `/settings` → `setting`).

**Python-side** (commands that affect LLM state or need PIL): `/reset` (wipe conversation history + caches), `/dump` (build full LLM context and send as .txt attachment), `/sticker` (PIL-based meme sticker; parallel to Node's ffmpeg/sharp path). These are handled inline in `python/bridge/main.py`. The bridge also handles the `clear_history`, `invalidate_chat_settings`, `invalidate_llm2_model`, and `set_subagent_enabled` control messages that Node sends after certain slash commands execute.

The `run_command` action lets LLM2 execute a slash command on Node indirectly — for example, the `reply_message` tool can bundle a `command` parameter to run `/sticker` on an attached image.

## Debounce mechanism
Inbound messages from the same chat are batched into a **burst** before processing:

- **Private chats**: debounce is skipped entirely — every message is processed immediately.
- **Prefix/hybrid mode**: debounce is skipped if any message in the pending buffer matches a configured trigger prefix. Non-matching messages still wait for the debounce window.
- **Auto mode**: all messages wait for the debounce window.
- **Burst parameters**: `INCOMING_DEBOUNCE_SECONDS` (default 5s) is the quiet-time window; `INCOMING_BURST_MAX_SECONDS` caps how long a burst can accumulate. The burst flushes when either the quiet deadline or the hard deadline is reached.

## Dedup mechanisms
Two separate dedup windows prevent duplicate or near-duplicate outputs:

- **Reply dedup**: `BRIDGE_REPLY_DEDUP_WINDOW_MS` (default 2 min). LLM2 reply texts shorter than `BRIDGE_REPLY_DEDUP_MIN_CHARS` (default 24) are compared against recent replies. If an identical (or near-identical via normalized comparison) reply was sent within the window, it is suppressed.
- **Echo merge**: `BRIDGE_ASSISTANT_ECHO_MERGE_WINDOW_MS` (default 3 min). When Node receives an outbound message from its own bot JID (an "echo"), the bridge merges it into the provisional pending history entry (updating `context_msg_id` from `"pending"` to the real ID) — unless the echo is older than the window (i.e., it's an old message that was re-delivered).

## Mute enforcement
Mutes are enforced on the Python bridge **before** the debounce stage:
1. When an `incoming_message` arrives, Python checks if the sender's `senderRef` has an active mute in the moderation DB.
2. If muted, the message is immediately deleted via a `delete_message` action sent to Node. No LLM processing occurs.
3. On first mute violation, the bridge sends an informational notice to the group (e.g., "Message from X deleted, Y minutes remaining").
4. When the bot is promoted to admin (detected via `botrolechange` message type), all active mutes in that group are cleared — moderation features become available.

## Bot role change notifications
When the bot is promoted or demoted in a group, WhatsApp sends a `botrolechange` message type. The bridge detects this and:
- **Promotion to admin**: clears all active mutes for the group (previous mutes issued when the bot lacked admin powers were unenforceable) and sends a notification that moderation features are now available.
- **Demotion**: no special action; moderation actions will fail with permission errors on next use.

## Interactive UI
- `/setting`, `/model`, and quiz messages use NativeFlow buttons/lists (mobile-only, not visible on WhatsApp Web).
- Button clicks produce a `selectedId` like `model_select:<id>`.
- Interactive quiz messages are tracked in the `quizMessageIds` set so that replies to them (quoted message references) are correctly identified as quiz answers.
- See ADR-1 in AGENTS.md for why `relayMessage` + `additionalNodes` is required for interactive message rendering.
