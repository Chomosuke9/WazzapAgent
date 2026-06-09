# 02 — Modules Map

## Node side (`src/`)

### Core bootstrap & infrastructure
- `src/index.js` — Bootstrap: SQLite init, WhatsApp socket lifecycle, WS client connect, action dispatcher from Python commands.
- `src/wsClient.js` — WebSocket client to Python bridge. Best-effort `send()` for transient messages; queued `sendReliable()` for state-sync events. Exponential backoff with symmetric jitter, heartbeat `isAlive` pattern.
- `src/config.js` — Env parsing + runtime path resolution (data/auth, data/media, data/stickers).
- `src/db.js` — Accesses SQLite database files shared with the Python bridge (separate module from `python/bridge/db.py`).
- `src/logger.js` — Structured pino logger.
- `src/identifiers.js` — `contextMsgId` (6-digit per-chat monotonic sequence), `senderRef` registry, message index for quoted-message resolution.
- `src/caches.js` — In-memory LRU caches for messages, groups, and participants.
- `src/mediaHandler.js` — Media download from Baileys, size/type validation, filesystem path resolution.
- `src/messageParser.js` — Baileys message unwrapping: viewOnce, interactive, buttons, ephemeral, protocol messages.
- `src/participants.js` — Group participant role/name caching, bot-owner detection, role-flag helpers.
- `src/groupContext.js` — Group metadata fetching + caching + invalidation.

### Utility modules (`src/utils/`)
- `src/utils/index.js` — Stream conversion: `streamToBuffer`, `streamToFile` (handles both async iterables and Node streams).
- `src/utils/cachedAuthState.js` — In-memory cached wrapper around Baileys `useMultiFileAuthState` to avoid repeated disk reads on key lookups; writes persist both cache and disk.

### WhatsApp integration (`src/wa/`)
- `src/wa/index.js` — Barrel re-export of all public WhatsApp API functions.
- `src/wa/connection.js` — Baileys v7 socket init and lifecycle (QR pairing, reconnect, creds update), button/list response handler, incoming message routing to command handler or Python WS.
- `src/wa/inbound.js` — Normalize raw Baileys message events into `incoming_message` payloads for the Python bridge.
- `src/wa/outbound.js` — Send text, media, mentions, and Lottie stickers to WhatsApp. Resolves `@senderRef` mentions to JIDs.
- `src/wa/actions.js` — Wrappers for message reactions (`reactToMessage`) and deletion (`deleteMessageByContextId`).
- `src/wa/moderation.js` — Kick members from groups.
- `src/wa/presence.js` — Mark chat as read, send typing/recording presence.
- `src/wa/commandHandler.js` — Central slash command dispatcher: routes parsed command to the correct handler module. (Alias normalization lives in `src/wa/command/parseCommand.js:7`.)
- `src/wa/runCommand.js` — Gateway-side handler for Python's `run_command` action. Synthesises a fake `msg` object (with optional quoted reply) so LLM-triggered commands execute identically to human-typed ones.
- `src/wa/sendQueue.js` — Per-JID serialization queue for outbound sends. Prevents Baileys ack races when two concurrent calls target the same JID.
- `src/wa/events.js` — Synthetic context events: action log entries, group join/leave summaries, bot role change notifications.
- `src/wa/utils.js` — Concurrency helpers: `semaphore`, `withRetry` (exponential backoff), `escapeRegex`.

### Per-command handlers (`src/wa/command/`)
- `src/wa/command/index.js` — Barrel re-export of all command handler functions.
- `src/wa/command/parseCommand.js` — Parse `/command arg1 arg2` strings into `{command, args}`.
- `src/wa/command/activate.js` — Activate a chat using an activation code.
- `src/wa/command/addsticker.js` — Add a sticker image to the user-managed catalog.
- `src/wa/command/announcement.js` — Send a group announcement message.
- `src/wa/command/broadcast.js` — Owner-only: broadcast a message to all active chats.
- `src/wa/command/catch.js` — Dump raw JSON cache of a quoted message for debugging (retrieves cached message payload).
- `src/wa/command/dashboard.js` — Display per-chat or global stats dashboard.
- `src/wa/command/debug.js` — Diagnostic command: environment info, connection state, cache stats.
- `src/wa/command/generate.js` — Generate image or content via the LLM pipeline.
- `src/wa/command/groupStatus.js` — Group status report: participants, roles, settings.
- `src/wa/command/groupStatusHelpers.js` — Pure helper functions for group status formatting (no I/O, no handler export).
- `src/wa/command/help.js` — Display available commands and usage.
- `src/wa/command/idle.js` — Configure idle trigger parameters (min/max message count, probability curve).
- `src/wa/command/info.js` — Display chat metadata, model config, and version info.
- `src/wa/command/join.js` — Join a group via invite link.
- `src/wa/command/model.js` — Per-chat model selection and configuration.
- `src/wa/command/modelcfg.js` — Global default model configuration.
- `src/wa/command/mode.js` — Chat mode: `auto`, `prefix`, `hybrid`.
- `src/wa/command/monitor.js` — Show activation code dashboard and activated chat list (owner only).
- `src/wa/command/ownerContact.js` — Display the bot owner's contact info.
- `src/wa/command/permission.js` — Permission level management per chat.
- `src/wa/command/prompt.js` — Set or clear per-chat system prompt override.
- `src/wa/command/removesticker.js` — Remove a sticker from the user-managed catalog.
- `src/wa/command/reset.js` — Reset chat state (clear history, reset counters).
- `src/wa/command/revoke.js` — Revoke the group's invite link.
- `src/wa/command/setting.js` — Interactive settings menu (buttons/lists).
- `src/wa/command/sticker.js` — Create a sticker from an image or video.
- `src/wa/command/subagent.js` — Enable or disable the sub-agent per chat.
- `src/wa/command/trigger.js` — Manage trigger words for prefix/hybrid modes.

### Interactive message builders (`src/wa/interactive/`)
- `src/wa/interactive/index.js` — Barrel re-export of all interactive send functions.
- `src/wa/interactive/sendInteractive.js` — Low-level helper: viewOnce message wrapper, device metadata injection, `relayMessage` with binary XML `additionalNodes` (required for NativeFlow rendering).
- `src/wa/interactive/sendButtons.js` — Quick reply buttons, CTA URL, copy-code, call-button, and combined button layouts. Also: legacy template buttons.
- `src/wa/interactive/sendCarousel.js` — Swipeable carousel cards with image, title, description, and footer buttons.
- `src/wa/interactive/README.md` — Implementation notes for interactive message builders (506 lines).

---

## Python side (`python/bridge/`)

### Core
- `__init__.py` — Package marker.
- `main.py` — WebSocket server on `:8080`, message batching with debounce, main processing loop. Also handles: mute enforcement (instant delete before debounce), `/dump` command (serialises full LLM context and sends as `.txt` attachment), bot role change notifications, hybrid mode prefix interrupt (cancels in-flight LLM1 when a prefix match arrives), idle trigger probabilistic firing, and re-invoke dedup skip.
- `db.py` — SQLite access layer: settings, per-chat models, mute rules, idle trigger config, stats counters. Reads/writes shared with Node via `settings.db`, `stats.db`, `moderation.db`.
- `dashboard.py` — Stats buffer: accumulates per-chat metrics, periodic 60s flush, dashboard text formatting for LLM consumption.
- `commands.py` — Legacy slash command parser and handler (Python-side subset of commands processed before debounce, e.g. `/dump`).
- `history.py` — `WhatsAppMessage` dataclass, history window assembly. Also handles: provisional history entries (`local-send-{id}` for speculative/LLM-originated sends), echo merge (deduplicates messages echoed back from WhatsApp).
- `config.py` — Env variable parsing + bridge-level constants (debounce timings, history limits, burst windows).
- `log.py` — Structured logging setup with JSON formatting.
- `media.py` — Visual attachment processing: base64 encoding for LLM vision, size limits, MIME type validation.
- `stickers.py` — Sticker catalog scanning: reads `data/stickers/` directory, indexes available stickers for LLM2 tool.
- `sticker_db.py` — Sticker database: user-managed sticker catalog in a dedicated `stickers.db` SQLite file, separate from bot settings.

### Messaging pipeline (`python/bridge/messaging/`)
- `__init__.py` — Package marker.
- `processing.py` — Burst building and processing: payload normalization, media dedup within a burst, dedup logic via `_is_duplicate_reply` (prevents near-identical LLM2 replies within a configurable time+character window).
- `filtering.py` — Ingress filtering: trigger word matching (prefix/hybrid mode), echo detection, idle trigger probability calculation. Decides whether a message enters the pipeline.
- `actions.py` — Parse control lines and LLM2 tool calls into action dicts (`reply_message`, `react_message`, `delete_message`, `mute_member`, `kick_members`, `send_sticker`, etc.).
- `gateway.py` — Serialise action dicts into WS JSON messages and send to Node. Handles per-action `requestId` tracking for `action_ack` matching.
- `moderation.py` — Permission checks against per-chat levels, moderation payload merge into LLM context.
- `format.py` — WhatsApp text formatting sanitisation: converts LLM-style Markdown (double-asterisk bold, etc.) to WhatsApp-native formatting (single-asterisk).

### LLM pipeline (`python/bridge/llm/`)
- `__init__.py` — Package marker.
- `llm1.py` — Routing/decision model: given a message burst, should the bot respond, express-only (emoji/sticker), or skip? Runs only in group chats; skipped in DMs.
- `llm2.py` — Response generation model: produces text reply + tool calls. Handles permission gating, mute rules injection, and express-only mode.
- `schemas.py` — Tool schema definitions as JSON Schema / OpenAI function-calling format. Defines `REPLY_MESSAGE_TOOL`, `REACT_MESSAGE_TOOL`, `DELETE_MESSAGES_TOOL`, `MUTE_MEMBER_TOOL`, `KICK_MEMBERS_TOOL`, `SEND_STICKER_TOOL`, and others. Functions for building the tool list gated by permission level.
- `prompt.py` — System prompt assembly: injects history window, context metadata, sticker catalog, prompt overrides, and mute rules into the LLM2 prompt.
- `client.py` — LLM client factory: creates `ChatOpenAI` instances from LangChain. Supports primary + fallback endpoint/model/key pairs for both LLM1 and LLM2.
- `metadata.py` — Context metadata extraction: bot mention detection, reply signal analysis, history window stats (message count, age range).
- `tool_utils.py` — Cross-provider tool-call extraction: normalises OpenAI, Anthropic, and other provider tool-call formats into a unified action list.
- `error_utils.py` — Shared error-inspection utilities: timeout detection across LLM providers.

### Sub-agent system (`python/bridge/subagent/`)
- `__init__.py` — Package marker.
- `tracker.py` — Sub-agent execution state tracker: session lifecycle, pending/running/completed state management, timeout enforcement.
- `client.py` — HTTP client for communicating with the sub-agent service (docker container or external process).
- `webhook_server.py` — Webhook server that receives sub-agent completion callbacks, routes results back to the main processing loop.
- `config.py` — Sub-agent environment configuration: endpoint URL, timeouts, work directory paths.
- `output.py` — Sub-agent input/output staging: writes task inputs to the work directory, reads and parses output files on completion, dispatches result messages.
- `models.py` — Sub-agent data models: dataclasses for session state, task definitions, and completion results.

### Tool implementations (`python/bridge/tools/`)
- `__init__.py` — Package marker.
- `sticker.py` — PIL-based sticker creation: square-pad images, overlay text with outlined font, embed WhatsApp EXIF metadata (`sticker-pack-id`, `sticker-pack-name`).
- `thumbnail.py` — Document thumbnail generation: creates JPEG thumbnails from PDFs and images for WhatsApp document previews.
