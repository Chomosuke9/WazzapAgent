# 05 - State, Data, and DB

## Runtime state (in-memory)

### Node side

| State | Type | Description |
|-------|------|-------------|
| **Group metadata cache** | `Map` (TTL 60s) | Cached group names, descriptions, participant lists, and admin roles. Invalidated on `groups.update` and `group-participants.update` events. |
| **Message ID / contextMsgId index** | Two `Map`s (12k + 24k) | Two-map architecture: `messageKeyIndex` (12k keys, contextMsgId → message key) and `messageIdToContextId` (24k keys, messageId → contextMsgId). Used for reply targeting and action resolution. |
| **senderRef registry** | `Map[chatId → Map]` | Per-chat bidirectional mapping between JIDs and short senderRef tokens derived from `SHA1(chatId|senderId|attempt)`. Rebuilt from incoming messages on reconnect. |
| **Quiz message IDs** | `Set` (bounded 2,000) | Tracks WhatsApp message IDs of sent quiz interactive messages (`quizMessageIds`). Used by `src/wa/inbound.ts` to distinguish quiz replies (forward to LLM) from settings menu replies (handle locally). |
| **Sticker catalog cache** | Module-level dict | Cached file listing of `STICKERS_DIR` (`data/stickers/`). Scanned at startup by Python's `stickers.py`; updated by Node's `src/wa/command/addsticker.ts` writing to `sticker_db`. |
| **Perf logging buffers** | None (ad-hoc) | When `PERF_LOG_ENABLED` is set, slow operations log structured metrics via `logger.info`: inbound message parsing (`src/wa/inbound.ts`), message upsert batches (`src/wa/connection.ts`). Threshold controlled by `PERF_LOG_THRESHOLD_MS` (default 400ms). |
| **Reliable WS queue** | `Array` (bounded 1,000) | Per-account in-memory array of queued Node→Python control events (`sendReliableToClient()` on `src/server/accountRegistry.ts`). Flushed when that account's client reconnects. Oldest dropped when queue exceeds `MAX_RELIABLE_QUEUE`. |
| **Pending send request chat** | `OrderedDict[str, str]` (max 4,096) | Maps `request_id → chat_id` for in-flight `send_message` actions awaiting `action_ack`. Used to hydrate provisional history entries with real contextMsgIds. LRU-evicted. |
| **Pending subagent attachments** | `OrderedDict[str, tuple[str, list[dict]]]` (max 4,096) | Staged sub-agent output files awaiting `action_ack`. Keyed by `request_id` (e.g. `subagent_attach-1715097600000-000042`). On ack, stores file paths into `media_paths_by_chat` under the real contextMsgId. LRU-evicted. |
| **Pending run command chat** | `OrderedDict[str, tuple[str, str]]` (max 4,096) | Tracks `run_command` actions awaiting `action_ack`. Keyed by `request_id`; value is `(chat_id, command_text)`. On ack, appends synthetic "Command executed" entry to per-chat history. LRU-evicted. |

### Python side

| State | Type | Description |
|-------|------|-------------|
| **Per-chat history** | `Deque[WhatsAppMessage]` | Rolling per-chat deque of message objects, capped by `HISTORY_LIMIT` (default 20). Oldest entries evicted when full. |
| **Pending burst buffers** | `Dict[chatId → PendingChat]` | Per-chat message accumulation during debounce window (`INCOMING_DEBOUNCE_SECONDS` / `INCOMING_BURST_MAX_SECONDS`). Skipped in private chats and prefix/hybrid mode when prefix matches. |
| **Dashboard counters** | In-memory buffer | Stats counters flushed to `stats.db` every 60 seconds. On flush failure, data is requeued. |
| **DB read caches** | Plain dicts (no TTL) | Caches for prompt, permission, mode, triggers, model lookups, and subagent state. Invalidated **explicitly** via WS events (`invalidate_chat_settings`, `invalidate_llm2_model`, `invalidate_default_model`) — no TTL. |
| **Mute cache** | `Dict[chatId → Dict[senderRef → dict]]` | In-memory cache (`_mute_cache`) of active mutes. Each entry stores `muted_at`, `duration_m`, and `notified` (3 fields). Checked before a message enters the debounce pipeline. Populated lazily on first `is_muted()` call per chat. Cleared on `clear_mutes()`. |
| **Reply dedup signatures** | `Dict[chatId, Deque[tuple[timestamp, signature]]]` | Per-chat deque of reply text signatures (max 24 entries). Each entry is `(timestamp_ms, sha1_prefix)`. Used by `_is_duplicate_reply()` to avoid sending duplicate responses within `REPLY_DEDUP_WINDOW_MS` (default 2 min). Signatures shorter than `REPLY_DEDUP_MIN_CHARS` (default 24) are not tracked. |
| **Provisional history entries** | Inline in per-chat history | Bot-sent messages start with `context_msg_id="pending"`. Hydrated to their real contextMsgId when Node sends `action_ack` for `send_message`. Allows LLM2 to see its own replies in context immediately. |
| **Sticker catalog** | Module-level dict + DB | Filesystem catalog (`_catalog` dict, lazy-scanned from `data/stickers/`) merged with per-chat DB entries from `sticker_db`. Per-chat user stickers override filesystem catalog when present. |
| **Sub-agent state** | `SubTaskTracker` (global) | Global `SubTaskTracker` instance with `_active` dict (in-flight sessions keyed by session_id) and `_history` dict (per-chat deque of completed tasks, max 50 each). Tracks progress steps, final result, steering signals. |
| **Media paths by chat** | `Dict[chatId → Dict[ctxId → list[dict]]]` | Staged file paths for sub-agent output and downloaded attachments. Keyed by contextMsgId. Entries stale after 24h (`_cleanup_stale_media_paths`). Populated from sub-agent completion webhooks and action_ack hydration. |
| **Pending sub-agent attachments** | `OrderedDict[str → tuple[chatId, list[dict]]]` | Sub-agent output files awaiting action_ack. LRU-evicted to prevent unbounded growth. |
| **Pending run command chat** | `OrderedDict[str → tuple[chatId, command]]` | `run_command` actions awaiting action_ack. On ack, synthetic "Command executed" entry appended to history. LRU-evicted. |

## SQLite databases

The system uses four core SQLite databases (WAL mode) to avoid locking contention, plus a separate `stickers.db`:

| Database | Tables | Primary writer | Primary reader |
|----------|--------|---------------|---------------|
| `settings.db` | `chat_settings`, `llm_models`, `activation_codes`, `chat_activations`, `owner_contact` | Node | Both |
| `stats.db` | `chat_stats`, `chat_user_stats` | Python | Node |
| `moderation.db` | `chat_mutes` | Python | Python |
| `subagent.db` | `subagent_enabled` | Node | Python |
| `stickers.db` | `stickers` | Node | Python |

### Table details

#### `chat_settings` (in `settings.db`)
Per-chat configuration — one row per chat plus a `__global__` defaults row:

| Column | Type | Description |
|--------|------|-------------|
| `chat_id` | `TEXT PK` | WhatsApp JID of the chat, or `__global__` for defaults |
| `prompt` | `TEXT` | Custom system prompt override (NULL = use default) |
| `permission` | `INTEGER` | Moderation level 0–3 (0 = none, 3 = full), default `0` |
| `mode` | `TEXT` | Trigger mode: `auto`, `prefix`, or `hybrid`, default `'prefix'` |
| `triggers` | `TEXT` | Comma-separated trigger prefixes (e.g. `"bot, wazzap"`), default `'tag,reply,name'` |
| `llm2_model` | `TEXT` | Per-chat model override (NULL = use default from `llm_models`) |
| `subagent_enabled` | `INTEGER` | 0/1 — sub-agent toggle per chat |
| `idle_trigger_min` | `INTEGER` | Minimum idle messages before probabilistic trigger |
| `idle_trigger_max` | `INTEGER` | Maximum idle messages (always triggers at this count) |
| `announcement_enabled` | `INTEGER` | 0/1 — `/announcement` command allowed in this chat, default `1` |
| `updated_at` | `TEXT` | ISO-8601 timestamp, auto-set via `datetime('now')` |

#### `llm_models` (in `settings.db`)
Model catalog — available LLM2 models selectable via `/model`:

| Column | Type | Description |
|--------|------|-------------|
| `model_id` | `TEXT PK` | Unique model identifier |
| `display_name` | `TEXT` | Human-friendly name shown in `/model` and `/modelcfg` |
| `description` | `TEXT` | Optional description (shown in `/modelcfg`) |
| `is_active` | `INTEGER` | 0/1 — whether model is available for selection |
| `sort_order` | `INTEGER` | Lowest = default model for new chats |
| `vision_support` | `INTEGER` | 0/1 — whether model supports image input |

#### `activation_codes` (in `settings.db`)
One-time activation codes for gating access when `REQUIRE_ACTIVATION=true`:

| Column | Type | Description |
|--------|------|-------------|
| `id` | `INTEGER PK AUTOINCREMENT` | Auto-increment ID |
| `code` | `TEXT UNIQUE` | Activation code string |
| `type` | `TEXT` | Code type (e.g. `"permanent"`, `"trial"`) |
| `days` | `INTEGER` | Duration in days (0 = permanent) |
| `used` | `INTEGER` | 0/1 — whether the code has been consumed |
| `used_by` | `TEXT` | JID of the chat that used the code |
| `created_at` | `TEXT` | ISO-8601 creation timestamp |
| `created_by` | `TEXT` | JID of the admin who created the code |

#### `chat_activations` (in `settings.db`)
Tracks which chats have activated and when:

| Column | Type | Description |
|--------|------|-------------|
| `chat_id` | `TEXT PK` | WhatsApp JID of the activated chat |
| `code` | `TEXT` | Code used for activation |
| `activated_at` | `TEXT` | ISO-8601 activation timestamp |
| `expires_at` | `TEXT` | ISO-8601 expiration (NULL = permanent) |
| `expiry_notified` | `INTEGER` | 0/1 — whether expiry warning has been sent |

#### `chat_stats` (in `stats.db`)
Periodic aggregation of chat activity metrics, flushed from Python's dashboard buffer:

| Column | Type | Description |
|--------|------|-------------|
| `chat_id` | `TEXT` | WhatsApp JID of the chat |
| `period_type` | `TEXT` | Aggregation period (`"daily"`, `"hourly"`) |
| `period_key` | `TEXT` | Period identifier (e.g. `"2025-03-15"`, `"2025-03-15-14"`) |
| `stat_key` | `TEXT` | Metric name (`"messages"`, `"tokens_in"`, `"tokens_out"`, `"actions"`) |
| `stat_value` | `INTEGER` | Counter value |

Primary key: `(chat_id, period_type, period_key, stat_key)`.

#### `chat_user_stats` (in `stats.db`)
Per-user invocation statistics for dashboard display:

| Column | Type | Description |
|--------|------|-------------|
| `chat_id` | `TEXT` | WhatsApp JID of the chat |
| `period_type` | `TEXT` | Aggregation period |
| `period_key` | `TEXT` | Period identifier |
| `sender_ref` | `TEXT` | Sender's short reference token |
| `sender_name` | `TEXT` | Display name at time of recording |
| `invoke_count` | `INTEGER` | Number of LLM invocations triggered |

Primary key: `(chat_id, period_type, period_key, sender_ref)`.

#### `chat_mutes` (in `moderation.db`)
Active mutes per user per chat, with expiration timestamps:

| Column | Type | Description |
|--------|------|-------------|
| `chat_id` | `TEXT` | WhatsApp JID of the chat |
| `sender_ref` | `TEXT` | Muted user's senderRef |
| `muted_at` | `TEXT` | ISO-8601 when the mute was applied |
| `duration_m` | `INTEGER` | Duration in minutes (60 = default, clamped to 1–1440) |

Primary key: `(chat_id, sender_ref)`. Expired mutes are cleaned lazily on lookup.

#### `owner_contact` (in `settings.db`)
Single-row table storing bot owner contact info for `/owner-contact` command:

| Column | Type | Description |
|--------|------|-------------|
| `id` | `INTEGER PK` | Constrained to 1 (single row) |
| `phone_number` | `TEXT` | Owner's phone number |
| `display_name` | `TEXT` | Owner's display name |
| `updated_at` | `TEXT` | ISO-8601 timestamp, auto-set via `datetime('now')` |

#### `subagent_enabled` (in `subagent.db`)
Per-chat sub-agent toggle (migrated into `chat_settings.subagent_enabled` on init):

| Column | Type | Description |
|--------|------|-------------|
| `chat_id` | `TEXT PK` | WhatsApp JID of the chat |
| `enabled` | `INTEGER` | 0/1 — whether sub-agent is enabled |
| `updated_at` | `TEXT` | ISO-8601 timestamp |

#### `stickers` (in `stickers.db`)
User-uploaded sticker catalog (5th separate DB to isolate from settings):

| Column | Type | Description |
|--------|------|-------------|
| `chat_id` | `TEXT` | Chat that owns the sticker (NULL = global) |
| `name` | `TEXT` | Sticker name (lowercased, trimmed) |
| `file_path` | `TEXT` | Absolute path to the stored .webp file (empty for Lottie-only) |
| `lottie_payload` | `TEXT` | JSON of the full Lottie sticker message payload (NULL for regular) |
| `added_by` | `TEXT` | JID of the member who added it |
| `added_at` | `TEXT` | ISO-8601 timestamp |

Primary key: `(chat_id, name)`.

## Environment variable paths
- `DATA_DIR` — Runtime data directory (default: `./data`)
- `MEDIA_DIR` — Downloaded media directory (default: `./data/media`)
- `STICKERS_DIR` — Sticker catalog directory (default: `./data/stickers`)
- `SETTINGS_DB_PATH` — Path to `settings.db` (default: `data/settings.db`)
- `STATS_DB_PATH` — Path to `stats.db` (default: `data/stats.db`)
- `MODERATION_DB_PATH` — Path to `moderation.db` (default: `data/moderation.db`)
- `SUBAGENT_DB_PATH` — Path to `subagent.db` (default: `data/subagent.db`)
- `STICKERS_DB_PATH` — Path to `stickers.db` (default: `data/stickers.db`)
- `STICKER_UPLOAD_DIR` — User-uploaded sticker directory (default: `data/stickers_user`)
- `BOT_SETTINGS_DB_PATH` — Override for Python's `settings.db` path
- `BOT_STATS_DB_PATH` — Override for Python's `stats.db` path
- `BOT_MODERATION_DB_PATH` — Override for Python's `moderation.db` path

## Dashboard notes
- Counters are recorded in RAM first, then flushed to DB in batches.
- If a flush fails, data is requeued so it isn't lost.
- `/dashboard` reads from `stats.db` via Node and formats the response text.

## Media storage

### Download path
Inbound media (images, videos, documents, stickers) are downloaded by `src/mediaHandler.ts` using Baileys' `downloadContentFromMessage`. Files are written to `MEDIA_DIR` with the naming convention:

```
{MEDIA_DIR}/{messageId}_{kind}.{ext}
```

The extension is inferred from the MIME type via `inferExtension()` (e.g. `jpeg` → `.jpg`, `video/mp4` → `.mp4`, `audio/mp4` → `.m4a`). Unknown MIME types fall back to `.bin`.

### Validation and limits
- **MIME type check**: The content type from the download stream is normalized and validated before writing.
- **Size limits**: Controlled by `DOWNLOAD_TIMEOUT_MS` (timeout, not hard size cap) and `LLM_MEDIA_MAX_ITEMS` / `LLM_MEDIA_MAX_BYTES` for what gets forwarded to the LLM.
- **Timeout**: If download exceeds `DOWNLOAD_TIMEOUT_MS`, the file is discarded and an error is logged.

### Path sandboxing
The `resolveAllowedAttachmentPath()` function in `src/mediaHandler.ts` prevents path traversal by:
1. Resolving the candidate path with `path.resolve()`.
2. Computing `fs.realpath()` for both the candidate and the allowed directories (`MEDIA_DIR`, `STICKERS_DIR`, `STICKER_UPLOAD_DIR`).
3. Verifying the candidate is within one of the allowed trees using `path.relative()` — rejects paths starting with `..` or absolute paths outside the sandbox.

Three directories are allowed for attachment resolution:
- `MEDIA_DIR` — downloaded media
- `STICKERS_DIR` — admin-managed static stickers
- `STICKER_UPLOAD_DIR` — user-uploaded stickers (`data/stickers_user/` by default)

### Cleanup
Media cleanup is **not automatic**. Old files accumulate in `MEDIA_DIR` indefinitely. Manual cleanup (e.g. a cron job deleting files older than N days) is recommended.

## Sticker catalog

Stickers are stored in two layers:

### Filesystem catalog (`STICKERS_DIR`)
- **Static stickers**: `.webp` files placed in `data/stickers/`. Scanned at startup by `python/bridge/stickers.py`.
- **Supported formats**: `.webp`, `.png`, `.jpg`, `.jpeg`, `.gif` — all converted to 512×512 WebP with WhatsApp EXIF metadata at send time.
- **Catalog text**: Injected into the LLM1 and LLM2 system prompts as `<sticker_catalog>...</sticker_catalog>` so the model knows available sticker names.

### Database catalog (`stickers.db`)
- **Static stickers**: Uploaded via `/addsticker` in Node, stored as `.webp` in `data/stickers/` with metadata in `stickers.db` (`stickers` table).
- **Lottie stickers**: Premium animated stickers uploaded via `/addsticker` are stored as raw Lottie JSON payloads in `stickers.db` (`lottie_payload` column). Sent verbatim via Baileys `relayMessage` to preserve full animation.

### Per-chat override
If a chat has any user-added stickers in `stickers.db`:
- The filesystem default catalog is **hidden** from the LLM — only user-added stickers appear in the catalog text.
- If a chat has no user stickers, the filesystem catalog is used as fallback.

### Catalog sources
- **Python side**: `stickers.py` (`_catalog` module-level dict) + `sticker_db.py` (SQLite queries).
- **Node side**: `src/wa/command/addsticker.ts` writes to `stickers.db`; removal is handled by `src/wa/command/removesticker.ts` (dispatched via `src/wa/commands/CommandRegistry.ts`).

## Auth state

### Location
Baileys multi-file auth state is stored in `data/auth/`. This directory is created automatically on first run and populated by the Baileys socket during pairing.

### Format
The directory contains one file per credential key, written by Baileys' multi-file auth state provider. Files include:
- `creds.json` — Signed identity key pair, registration ID, server token, etc.
- `session-*.json` — Session data for each connected device.

### Lifecycle
- **First run**: Directory is empty → Baileys generates new credentials → QR code printed to console. Scan within ~20 seconds.
- **Normal restarts**: Existing auth state reused → reconnection without QR.
- **Logged out**: WhatsApp logs out the session (e.g. multi-device limit reached) → gateway logs `"Logged out from WhatsApp"` and stops reconnecting.
- **Re-pairing**: Delete `data/auth/` entirely and restart. Never delete individual files.

### Corruption
If `data/auth/` is partially written during a crash (e.g. power loss mid-write), the auth state is **unrecoverable**. Attempting to reuse a partially written directory causes Baileys to fail with cryptic errors. The only fix is to delete the entire directory and re-pair.

### Security
- Never commit `data/auth/` to version control (already git-ignored).
- Rotating auth state = logging out all connected devices; only do this if the credentials are compromised.