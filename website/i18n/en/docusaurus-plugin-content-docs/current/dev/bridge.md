---
sidebar_position: 4
---

# Python LLM Bridge

Internal documentation for the Python LLM Bridge (`python/bridge/`). The bridge receives messages from the gateway and runs the LLM pipeline to generate responses.

## Tech Stack

- **Runtime:** Python 3.10+
- **WebSocket:** `websockets>=12.0`
- **LLM SDK:** `langchain>=0.2.0`, `langchain-openai>=0.1.0`
- **HTTP Client:** `httpx>=0.27.0`
- **Data Validation:** `pydantic>=2.7.0`
- **Database:** SQLite (built-in) via `sqlite3`
- **Environment:** `python-dotenv>=1.0.1`

## Entry Point (`main.py`)

### WebSocket Server

The bridge runs as a WebSocket server that accepts connections from the gateway. When receiving an `incoming_message`, the bridge:

1. Accumulates messages in a **burst window**.
2. After debounce, processes the batch as a whole.
3. Runs the LLM1 → LLM2 pipeline.
4. Sends commands back to the gateway.

### Message Batching

The bridge groups incoming messages for efficiency:

```
Message 1 arrives → start burst timer (5 seconds)
Message 2 arrives (3s later) → reset timer (5s from now)
Message 3 arrives (4s later) → reset timer again
...
Timer expires OR max burst (20s) reached → process batch
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `INCOMING_DEBOUNCE_SECONDS` | `5` | Debounce after last message |
| `INCOMING_BURST_MAX_SECONDS` | `20` | Max burst window duration |

### Deduplication

The bridge has dedup mechanisms to avoid duplicate responses:

- **Reply dedup:** If the bot already answered a similar message within `REPLY_DEDUP_WINDOW_MS` (default 120s), skip.
- **Assistant echo merge:** Bot's own messages echoed back from the gateway are merged if within `ASSISTANT_ECHO_MERGE_WINDOW_MS` (default 180s).

### Per-Chat State

Each chat has a `PendingChat` that stores:

```python
@dataclass
class PendingChat:
    payloads: list[dict]         # Messages being batched
    burst_started_at: float      # Burst start time
    last_event_at: float         # Last event time
    wake_event: asyncio.Event    # Signal to process batch
    task: asyncio.Task           # Background task per chat
    lock: asyncio.Lock           # Concurrency guard
```

## LLM1 — Gating (`llm1.py`)

LLM1 is the first stage that decides whether the bot should respond.

### Input

- Conversation history (compact text)
- Current messages (burst window)
- Metadata: mentions, replies, chat type, admin status

### Output

```python
@dataclass
class LLM1Decision:
    should_respond: bool    # Whether the bot should respond
    reason: str             # Decision reason (forwarded to LLM2)
```

### Configuration

- Can be disabled by leaving `LLM1_ENDPOINT` empty — all messages will get a response.
- Supports fallback provider if primary fails.
- Supports multimodal input (enabled via `LLM1_ENABLE_MEDIA_INPUT=1`).

### Features

- **Lightweight and fast** — Uses a small model with temperature 0.
- **History truncation** — History limited to `LLM1_HISTORY_LIMIT` messages, each message max `LLM1_MESSAGE_MAX_CHARS` characters.
- **Fallback:** If LLM1 fails, defaults to "respond" so the bot doesn't go silent.

## LLM2 — Responder (`llm2.py`)

LLM2 is the second stage that generates complete responses.

### Prompt Structure

LLM2 receives 4 messages in LangChain format:

1. **SystemMessage** — System prompt from `python/systemprompt.txt` with template variables:
   - `{{prompt_override}}` — Custom prompt from the `/prompt` command.
   - `{{assistant_name}}` — Bot display name.

2. **HumanMessage** — Group description:
   ```
   Group description:
   <group description>
   ```

3. **HumanMessage** — Context injection (metadata):
   ```
   Current message metadata:
   - Bot is mentioned 2 times in this current message window.
   - A message replies to the bot.
   - The last assistant reply was 5 messages ago.
   - Assistant has sent 1 reply in the last 20 messages.
   - There are 3 human messages in this current message window.

   Chat state:
   This is a group chat.
   Bot is an admin.
   Bot permissions: can delete messages, cannot kick members.
   ```

4. **HumanMessage** — History and current messages:
   ```
   older messages:
   <000120>[14:30]Alice (u8k2d1):Hello everyone
   <000121>[14:31]Bob (u1m9qa):Hi there

   current messages(burst):
   <000122>[14:35]Alice (u8k2d1):@Bot can you help?
   ```

### Multimodal Support

If `LLM2_ENABLE_MEDIA_INPUT=1` (default), the 4th message can include image blocks:

- Max `LLM_MEDIA_MAX_ITEMS` attachments (default: 2).
- Max `LLM_MEDIA_MAX_BYTES` total size (default: 5 MB).
- If multimodal fails, automatically falls back to text-only prompt.

### Retry & Fallback

```
Primary provider → fails → retry (if timeout, max LLM2_RETRY_MAX times)
                         → text-only fallback (if not timeout)
                         → fallback provider (if configured)
```

### Result Validation

Callers can provide a `result_validator` function. If validation fails, the result is treated as unusable and the fallback provider is tried.

## Slash Commands (`commands.py`)

### Commands Handled by Bridge

| Command | Access | Description |
|---------|--------|-------------|
| `/prompt <text>` | Admin (group), anyone (private) | Set custom prompt per chat |
| `/prompt` | Admin (group), anyone (private) | View current prompt |
| `/prompt clear` | Admin (group), anyone (private) | Clear custom prompt |
| `/reset` | Admin (group), anyone (private) | Reset conversation memory |
| `/permission <0-3>` | Admin (group only) | Set permission level |
| `/permission` | Admin (group only) | View current level |

### Commands Handled by Gateway

| Command | Access | Description |
|---------|--------|-------------|
| `/broadcast <text>` | Bot owner only | Broadcast to all chats |

### Processing Flow

```
1. Gateway detects slash command in message
2. Sends to bridge with `slashCommand: { command, args }` field
3. Bridge parses and executes command
4. If `skip_llm: true` → send response directly, skip LLM pipeline
5. If command not recognized → forward to normal LLM pipeline
```

## Database (`db.py`)

### Schema

```sql
CREATE TABLE chat_settings (
    chat_id    TEXT PRIMARY KEY,
    prompt     TEXT,
    permission INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Caching

- Reads go through an in-memory cache (`dict`) — the LLM pipeline never hits SQLite directly.
- Writes go through SQLite then invalidate the cache.
- Thread-safe with `threading.Lock`.
- Thread-local connections (one per thread).
- WAL mode for concurrent read performance.

### Permission Levels

| Level | Delete | Mute | Kick | Description |
|-------|--------|------|------|-------------|
| 0 | No | No | No | Default — moderation disabled |
| 1 | Yes | No | No | Delete messages only |
| 2 | Yes | Yes | No | Delete + mute members |
| 3 | Yes | Yes | Yes | Full moderation (delete + mute + kick) |

## History (`history.py`)

### WhatsAppMessage Dataclass

```python
@dataclass
class WhatsAppMessage:
    timestamp_ms: int
    sender: str                     # Display name or phone
    context_msg_id: str | None      # 6-digit ID
    sender_ref: str | None          # Short reference
    sender_is_admin: bool
    text: str | None
    media: str | None               # "image", "video", "sticker", etc.
    quoted_message_id: str | None
    quoted_sender: str | None
    quoted_text: str | None
    quoted_media: str | None
    message_id: str | None
    role: str                       # "user" | "assistant"
```

### History Format

```
<000120>[14:30]Alice (u8k2d1):Hello everyone
<000121>[14:31][Admin]Bob (u1m9qa):Group rules updated
  > reply_to: from=Alice | id=000120 | quoted_text=Hello everyone
<pending>[14:32]LLM (You):Hi! How can I help?
```

Format: `<contextMsgId>[HH:MM][Admin?]SenderName (senderRef):Text`

## Media Processing (`media.py`)

The `media.py` module processes visual attachments for multimodal LLM input:

- Reads files from local paths.
- Encodes to base64 for multimodal APIs.
- Limits count and size (`LLM_MEDIA_MAX_ITEMS`, `LLM_MEDIA_MAX_BYTES`).
- Redacts multimodal content for logging (replaces base64 with placeholders).

## Logging (`log.py`)

### Structured Logging

- Uses `contextvars` for chat-scoped context (chatId, chatName).
- Format: `[LEVEL][timestamp][chat_label] message extras=...`
- Chat label is fixed-width (configurable via `BRIDGE_LOG_CHAT_LABEL_WIDTH`).

### Helper Functions

| Function | Description |
|----------|-------------|
| `setup_logging()` | Configure logger with level and format |
| `set_chat_log_context(chat_id, chat_name)` | Set context for logging |
| `reset_chat_log_context()` | Reset context |
| `trunc(text, limit)` | Truncate text for logging |
| `dump_json(obj)` | Serialize object to JSON for logging |
| `env_flag(name)` | Check env variable as boolean flag |

## Code Conventions

- Python 3.10+ with `from __future__ import annotations` in every file.
- Type hints used consistently throughout.
- Dataclasses for data structures.
- Relative imports within the `python/bridge/` package.
- Async/await for I/O operations (WebSocket, LLM calls).
