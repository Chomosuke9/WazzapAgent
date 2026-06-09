# 01 - Runtime Flow

## A. Startup flow

1. **Node bootstrap** (`src/index.js`):
   - Load config from environment (`src/config.js`)
   - Initialize `settings.db`, `stats.db`, `moderation.db` via `src/db.js` (WAL mode, create tables if missing)
   - Create in-memory LRU caches (`src/caches.js`): groups, messages, participants
   - Start WhatsApp socket (`src/wa/connection.js`) — loads Baileys multi-file auth from `data/auth/`, emits QR if unpaired
   - Start WS client (`src/wsClient.js`) — connects to `LLM_WS_ENDPOINT`

2. **Python bootstrap** (`python/bridge/main.py`):
   - Load config from environment (`python/bridge/config.py`)
   - Open same three SQLite DBs (`python/bridge/db.py`)
   - Initialize in-memory state: per-chat `PendingChat` buffers, history rings, mute cache, stats counters
   - Start WS server on `:8080` with `ping_interval=20, ping_timeout=20`

3. **Handshake**:
   - After Node's WS client opens a connection, Node sends `{ type: "hello", instanceId }`
   - Python logs the handshake and continues — no response sent
   - On **reconnect** (WS drops and reopens), Node sends `hello` again — Python treats this as a full state sync trigger

## B. Incoming message flow (WhatsApp → Node → Python)

1. Baileys emits `messages.upsert` event on the socket.

2. **Node** `src/wa/connection.js` receives the event. Messages are filtered to deduplicate and ignore own messages (bot JID check).

3. **Slash command detection** (`src/wa/commandHandler.js`):
   - If the message text matches a known slash command (e.g., `/help`, `/reset`, `/mode`, `/prompt`), the command handler processes it immediately.
   - Some slash commands (like `/broadcast`, `/debug`, `/info`) are fully handled by Node and **do not** forward to Python.
   - Others (like `/reset`, `/model`) both execute locally **and** forward to Python via `sendReliable()` for state sync.
   - Button/list interactive responses (e.g., model selection from carousel) are also intercepted here and dispatched to the appropriate command module.

4. **Normalization** (`src/wa/inbound.js`):
   - Calls `src/messageParser.js` to unwrap the raw Baileys message:
     - Extract text body (handles `conversation`, `extendedTextMessage`, `imageMessage.caption`, `viewOnceMessage`, etc.)
     - Extract quoted message (parent `contextMsgId`, quoted text, quoted sender)
     - Extract media attachments (image, video, audio, document → download URL via `src/mediaHandler.js`)
     - Extract mentions (`mentionedJid` list → senderRef map)
     - Extract location data (if `locationMessage`)
   - Calls `src/identifiers.js` to assign:
     - `contextMsgId` — 6-digit per-chat monotonic counter (wraps at 999999)
     - `senderRef` — short deterministic reference for the sender in this chat
   - Calls `src/groupContext.js` to resolve group metadata (name, participant roles, bot admin status)
   - Calls `src/participants.js` to hydrate sender profile (display name, role)
   - Builds the normalized `incoming_message` payload.

5. **Node → Python delivery**:
   - Node sends `{ type: "incoming_message", ...payload }` to Python via `wsClient.send()` (best-effort, non-reliable).
   - If the WS is disconnected, the message is silently dropped — the next burst will carry newer state.

6. **Python** `python/bridge/main.py` WS `on_message` handler receives the event. Deserializes and validates the payload.

7. **Mute check**: Python queries the in-memory mute cache (backed by `moderation.db`). If the sender's `senderRef` is currently muted in this chat, the message is **dropped immediately** — no processing, no history insertion.

8. **Buffering**: Python places the payload into the per-chat `PendingChat` buffer (`python/bridge/messaging/processing.py`). If no buffer existed for this chat, one is created.

9. **Debounce**:
   - A debounce timer starts (or resets if one is already running) for this chat.
   - Timer duration: `INCOMING_DEBOUNCE_SECONDS` (default 5s).
   - A **burst max** limit (`INCOMING_BURST_MAX_SECONDS`, default 20.0s) forces processing even if messages keep arriving.
   - On timer expiry (or burst max reached), `flush_pending()` is called.

10. **Batch processing begins** (`python/bridge/messaging/processing.py:_process_chat()`):
    - Pop all messages from the pending buffer.
    - Merge them into the per-chat history ring (capped by `HISTORY_LIMIT`, default 20).

11. **Trigger filtering** (`python/bridge/messaging/filtering.py`):
    - Read chat mode (`auto`, `prefix`, `hybrid`) from `settings.db`.
    - **`auto`**: always process the batch.
    - **`prefix`**: check each message text against the chat's trigger prefixes. If **no** message matches, skip — batch is added to history only, no LLM call.
    - **`hybrid`**: same trigger check as prefix, but if a message contains an **explicit mention** of the bot's name, it counts as triggered.
    - Echo merge: incoming `fromMe=true, contextOnly=true` messages are merged into provisional history entries by exact normalized signature match within `ASSISTANT_ECHO_MERGE_WINDOW_MS` (avoids duplicate context from WhatsApp echo).

12. **LLM1 decision** (`python/bridge/llm/llm1.py`):
    - **Private chats**: bypass LLM1 entirely — always respond (confidence = 1.0).
    - **Group chats** with mode `auto` or `hybrid` (and trigger matched): run LLM1.
    - LLM1 receives a compacted version of the history + current burst messages.
    - LLM1 returns one of:
      - `should_respond` (with reason + confidence score)
      - `express_only` (respond with emoji/sticker only, no text)
      - `skip` (do not respond)
    - If `LLM1_ENDPOINT` is empty/not configured, LLM1 is **disabled** — every triggered batch proceeds to LLM2.

13. **LLM2 generation** (`python/bridge/llm/llm2.py`):
    - Assemble the system prompt:
      - Base template from `python/systemprompt.txt`
      - Chat-level `/prompt` override (if set in `settings.db`)
      - Assistant name env var
      - Group context (name, participant list with senderRefs)
    - Inject metadata (`python/bridge/llm/metadata.py`):
      - Whether bot was mentioned
      - Reply signals (which messages are being replied to)
      - Context window stats (message count, age of oldest message)
      - Permission flags (can delete, can kick, can mute)
    - Inject history ring + current burst messages.
    - If media is present and the provider supports multimodal: attach as base64 image.
    - Call LLM2 via LangChain `ChatOpenAI` (`python/bridge/llm/client.py`).
    - Tool schemas (`python/bridge/llm/schemas.py`) are passed as `tools` parameter.
    - On failure: retry up to configured limit, then try fallback provider (`LLM2_FALLBACK_*`), then give up.

14. **Parse LLM2 response** (`python/bridge/messaging/actions.py`):
    - Extract tool calls from the LLM response (`_extract_actions_from_tool_calls`).
   - Supported tools: `reply_message`, `react_to_message`, `delete_messages`, `mute_member`, `kick_members`, `send_quiz`, `send_sticker`, `execute_subtask`.
   - Validate permissions for each tool — both admin status AND permission level (0-3) are checked: `admin_ok and permission_allows_*(perm_level)`:
     - `reply_message`, `react_to_message`, `send_sticker`: always allowed.
     - `send_quiz`: always allowed.
     - `delete_messages`: requires `admin_ok and permission_allows_delete(level)` (level ≥ 1).
     - `mute_member`: requires `admin_ok and permission_allows_mute(level)` (level ≥ 2).
     - `kick_members`: requires `admin_ok and permission_allows_kick(level)` (level ≥ 3).
     - `execute_subtask`: requires sub-agent enabled for chat (independent of permission level).
    - Build action payloads with `type`, `chatId`, tool-specific params, and a unique `requestId`.

15. **Python → Node actions**:
   - Each action is its own WS message: `{ type: "<action_type>", payload: { requestId, chatId, ...params } }`.
   - Each action has a unique `requestId` (UUID).
   - Actions are sent individually, not batched.

16. **Node dispatches actions** (`src/index.js:dispatchCommand`):
    - `send_message` → `src/wa/outbound.js` → WhatsApp (text, mentions, media).
    - `react_message` → `src/wa/actions.js` → WhatsApp emoji reaction.
    - `delete_message` → `src/wa/actions.js` → WhatsApp message delete.
    - `kick_member` → `src/wa/moderation.js` → WhatsApp group remove.
    - `mark_read` + `send_presence` → `src/wa/presence.js` → typing indicator / read receipt.
    - `send_buttons` / `send_carousel` → `src/wa/interactive/` → NativeFlow interactive messages.

17. **Node → Python `action_ack`/`error`**:
   - For each processed action, Node responds with `{ type: "action_ack", payload: { requestId, action, ok, detail, result?, code? } }` or `{ type: "error", payload: { requestId, action, ok: false, detail, code? } }`.
   - Sent via `wsClient.send()` (best-effort).

18. **Python processes ack** (`python/bridge/messaging/gateway.py`):
    - If `send_message` succeeded: Python updates the provisional history entry with the real `contextMsgId` and WhatsApp message ID from the `result`.
    - If `error`: logged. Critical errors (permission denied, banned) may suppress retries; transient errors may trigger a retry or user-facing error message.

## C. Model switching flow

1. User selects a model from an interactive menu (`model_select:<modelId>` callback data from a carousel or button message) or runs `/model <modelId>`.

2. **Node** (`src/wa/command/model.js` or interactive handler):
   - Writes `chat_settings.llm2_model = <modelId>` to `settings.db`.
   - Reads the model config (endpoint, API key, temperature) from the `models` table.

3. **Node → Python sync** (via `wsClient.sendReliable()` — queued, guaranteed delivery):
   - `{ type: "set_llm2_model", chatId, modelId, config: { endpoint, apiKey, temperature } }` — authoritative sync.
   - `{ type: "invalidate_llm2_model", chatId }` — fallback cache clear.

4. **Python** (`python/bridge/db.py`):
   - Updates `settings.llm2_model` for the chat.
   - Clears any cached LLM2 client instance for this chat (forces re-creation with new config on next request).
   - On next LLM2 call, `python/bridge/llm/client.py` reads the fresh config and instantiates the new model.

5. If the **default model** is changed (admin-level `/model default:<modelId>`):
   - Node sends `{ type: "invalidate_default_model" }` via `sendReliable()`.
   - Python clears the global default model cache; all chats without a per-chat override pick up the new default on next request.

## D. Dashboard flow

1. **Python** records counters in an in-memory buffer during message processing: messages handled, LLM1 decisions, LLM2 calls, tool invocations, errors.

2. **Python** periodically (every 60s) flushes the counters to `stats.db` via `python/bridge/dashboard.py`.

3. **Node** `/dashboard` command (`src/wa/command/dashboard.js`):
   - Reads aggregated stats from `stats.db`.
   - Formats a summary text (messages today, response rate, model breakdown, etc.).
   - Sends the summary to the requesting chat.

## E. Reset flow

1. User runs `/reset`.

2. **Node** (`src/wa/command/reset.js`):
   - Sends `{ type: "clear_history", chatId }` via `wsClient.sendReliable()`.

3. **Python** (`python/bridge/main.py`):
   - Clears the per-chat history ring buffer.
   - Resets the idle message count for that chat.
   - Resets any in-flight debounce timers for the chat.
   - Note: the `contextMsgId` counter lives in Node.js (`src/identifiers.js`) and is NOT decremented on reset.

## F. Sub-agent flow

1. LLM2 calls the `execute_subtask` tool with parameters: `instruction`, `context_msg_ids` (optional, list of 6-digit contextMsgIds for media input), `high_quality` (boolean), `confirmation_text`.

2. **Python** (`python/bridge/subagent/` package):
   - Receives the tool call with `{ instruction, contextMsgIds, highQuality, confirmationText }`.
   - Sends an HTTP POST request to the sub-agent service (URL configured via `SUBAGENT_URL` env var): `{ taskId, instruction, callbackUrl, highQuality }`.
   - The sub-agent service is an independent LLM or processing pipeline designed for longer-running tasks (research, code generation, multi-step reasoning).

3. **Sub-agent processes the task** (may take seconds to minutes):
   - The sub-agent runs autonomously, potentially with multiple LLM calls, tool usage, or external API calls.
   - No real-time response is expected — the sub-agent operates asynchronously.

4. **Sub-agent calls back**:
   - When complete, the sub-agent sends the result via HTTP POST to the `callbackUrl`: `{ taskId, result, status }`.

5. **Python receives callback**:
   - `python/bridge/tools/subagent.py` receives the HTTP callback.
   - Formats the result into a reply message (text, potentially with attachments).

6. **Python sends reply**:
   - Sends a `send_message` action to Node (same path as normal LLM2 reply — steps 15–18 in flow B).
   - The reply includes the sub-agent's output, formatted as a coherent response in the chat.

## G. Idle trigger flow

1. **Per-chat `/idle <min-max>` configuration** stored in `settings.db`. Range defines how many user messages since the last bot reply should pass before the bot re-engages.

2. **Python** tracks `idle_msg_count` per chat (`python/bridge/main.py`). This counter is incremented for each non-empty batch that proceeds through the pipeline. It is reset to 0 whenever the bot sends a reply.

3. **Evaluated inline after LLM1 decisions**: after LLM1 decides to skip (or if LLM1 is disabled for this path), the bridge checks `_should_idle_trigger(chat_id, idle_msg_count)`:
   - Reads the per-chat `(min_val, max_val)` from DB.
   - If `msg_count < min_val`: no trigger.
   - If `min_val == max_val` or `msg_count >= max_val`: always trigger.
   - Otherwise, probability `P = 1 / (max_val - msg_count + 1)`.

4. **Bot initiates conversation**:
   - If the idle trigger fires, the bot proceeds to LLM2 generation (step 13 of flow B) as if the batch was triggered, generating a proactive reply based on recent chat context.
   - The reply is sent via normal `send_message` action path.
   - The `idle_msg_count` is reset to 0 on successful send.

## H. Quiz flow

1. **LLM2 calls `send_quiz` tool** with parameters: `{ context_msg_id, question, choices: [{label, text}], footer }`.

2. **Python** (`python/bridge/messaging/actions.py`):
   - Validates the quiz payload (min 2 choices, max 5, question non-empty).
   - Sends `{ type: "send_quiz", payload: { requestId, chatId, question, choices: [{label, text}], replyTo?, footer? } }` to Node.

3. **Node** (`src/index.js`):
   - Builds the quiz buttons with callback data `qz:<ch.label>` (e.g., `qz:A`, `qz:B`).
   - Sends via `relayMessage()` with `additionalNodes` (see ADR-1).
   - Tracks the sent message's WhatsApp message ID (`key.id`) in a `quizMessageIds` set (in-memory, bounded to 2000 entries) to identify responses.

4. **User taps a quiz button**:
   - WhatsApp sends a `messages.upsert` with the button response containing the `qz:<ch.label>` callback data.

5. **Node detects quiz response** (`src/wa/inbound.js`):
   - Two detection paths:
     - **Button tap**: `msg.message.templateButtonReplyMessage.selectedId` starts with `qz:` — sets `isQuizButtonReply = true`.
     - **Plain-text reply to a quiz**: `isQuizReply` checks `quoted.messageId` against the `quizMessageIds` Set.
   - In both cases, the message is forwarded to Python as a normal `incoming_message` payload — no special `quiz` metadata is added.

6. **Python processes quiz response**:
   - Python receives a normal `incoming_message`. There is no separate quiz evaluation flow — the response is handled by LLM2 as a regular user message with the quiz context in history.

## I. Reconnect / failure behavior

- **Python bridge restarts** (WS server goes down):
  - Node's WS client detects disconnection (heartbeat `isAlive` pattern at `WS_HEARTBEAT_INTERVAL_MS`).
  - Node begins reconnecting with exponential backoff + symmetric jitter:
    - Base delay: `WS_RECONNECT_MS` (default 5000ms).
    - Cap: `WS_RECONNECT_MAX_MS` (default 60000ms).
    - Jitter: `WS_RECONNECT_JITTER_RATIO` (default 0.2, i.e., ±20%).
    - The jittered delay is clamped to the cap.
    - Backoff resets only after the socket stays OPEN for a short grace period (prevents rapid reconnect loops when server accepts then immediately kicks).
  - Queued reliable messages (`sendReliable()`) are stored in an in-memory array (max 1000 entries; oldest dropped on overflow).
  - On reconnect, Node sends `hello` again, then flushes the reliable queue.
  - Non-reliable events (`incoming_message`) generated during downtime are lost — the next burst carries newer state.

- **Node restarts** (WS client disconnects):
  - Python's WS server detects the disconnection (ping/pong timeout).
  - Python does not persistently queue in-flight batches — any batch currently being processed is lost.
  - Python's WS server remains up, accepting new connections (no restart needed on Python side).
  - When Node's new instance starts, it connects and sends `hello` — normal operation resumes.

- **WhatsApp session logged out**:
  - Baileys emits `connection.update` with `connection: "loggedOut"`.
  - Node logs `"Logged out from WhatsApp"` and stops reconnecting.
  - Manual intervention required: delete `data/auth/` and restart to re-pair via QR.
