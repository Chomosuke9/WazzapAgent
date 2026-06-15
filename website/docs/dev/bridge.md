---
sidebar_position: 4
---

# Python LLM Bridge

Dokumentasi internal untuk Python LLM Bridge (`python/bridge/`). Bridge menerima pesan dari gateway dan menjalankan pipeline LLM untuk menghasilkan respons.

## Tech Stack

- **Runtime:** Python 3.10+
- **WebSocket:** `websockets>=12.0`
- **LLM SDK:** `langchain>=0.2.0`, `langchain-openai>=0.1.0`
- **HTTP Client:** `httpx>=0.27.0`
- **Data Validation:** `pydantic>=2.7.0`
- **Database:** SQLite (built-in) via `sqlite3`
- **Environment:** `python-dotenv>=1.0.1`

## Entry Point (`main.py`)

### WaSocket Client

Bridge berjalan sebagai **WaSocket client** yang men-_dial_ gateway Node di `NODE_URL` (gateway-lah yang menjadi WebSocket server). `main.py` memuat daftar akun (`accounts.py`) dan menjalankan satu `AgentSession` (`session.py`) per akun (`folder_path`). Setiap `AgentSession` adalah composition root yang merangkai collaborator di package `agent/` (mis. `batch_processor.py`, `llm1_router.py`, `llm2_responder.py`, `subagent_coordinator.py`, `mute_gate.py`, `reply_dedup.py`, `idle_trigger.py`, `ack_hydrator.py`, `event_router.py`). Saat menerima pesan `incoming_message`, bridge:

1. Mengakumulasi pesan dalam **burst window**.
2. Setelah debounce, memproses batch secara keseluruhan.
3. Menjalankan pipeline LLM1 → LLM2.
4. Mengirim command kembali ke gateway.

### Message Batching

Bridge mengelompokkan pesan masuk untuk efisiensi:

```
Pesan 1 masuk → mulai burst timer (5 detik)
Pesan 2 masuk (3 detik kemudian) → reset timer (5 detik dari sekarang)
Pesan 3 masuk (4 detik kemudian) → reset timer lagi
...
Timer habis ATAU max burst (20 detik) tercapai → proses batch
```

| Parameter | Default | Deskripsi |
|-----------|---------|-----------|
| `INCOMING_DEBOUNCE_SECONDS` | `5` | Debounce setelah pesan terakhir |
| `INCOMING_BURST_MAX_SECONDS` | `20` | Maks durasi burst window |

### Deduplication

Bridge memiliki mekanisme dedup untuk menghindari respons duplikat:

- **Reply dedup:** Jika bot sudah menjawab pesan serupa dalam `REPLY_DEDUP_WINDOW_MS` (default 120 detik), skip.
- **Assistant echo merge:** Pesan bot sendiri yang di-echo balik dari gateway di-merge jika dalam `ASSISTANT_ECHO_MERGE_WINDOW_MS` (default 180 detik).

### Chat State per Chat

Setiap chat memiliki `PendingChat` yang menyimpan:

```python
@dataclass
class PendingChat:
    payloads: list[dict]         # Pesan yang sedang di-batch
    burst_started_at: float      # Waktu mulai burst
    last_event_at: float         # Waktu event terakhir
    wake_event: asyncio.Event    # Signal untuk proses batch
    task: asyncio.Task           # Background task per chat
    lock: asyncio.Lock           # Concurrency guard
```

## LLM1 — Gating (`llm/llm1.py`)

LLM1 adalah tahap pertama yang memutuskan apakah bot harus merespons.

### Input

- History percakapan (teks compact)
- Pesan terkini (burst window)
- Metadata: mentions, reply, tipe chat, status admin

### Output

```python
@dataclass
class LLM1Decision:
    should_respond: bool    # Apakah bot harus merespons
    reason: str             # Alasan keputusan (diteruskan ke LLM2)
```

### Konfigurasi

- Bisa dinonaktifkan dengan mengosongkan `LLM1_ENDPOINT` — semua pesan akan di-respond.
- Support fallback provider jika primary gagal.
- Support multimodal input (diaktifkan via `LLM1_ENABLE_MEDIA_INPUT=1`).

### Fitur

- **Ringan dan cepat** — Menggunakan model kecil dengan temperature 0.
- **History truncation** — History di-limit `LLM1_HISTORY_LIMIT` pesan, setiap pesan max `LLM1_MESSAGE_MAX_CHARS` karakter.
- **Fallback:** Jika LLM1 gagal, default ke "respond" agar bot tidak diam.

## LLM2 — Responder (`llm/llm2.py`)

LLM2 adalah tahap kedua yang menghasilkan respons lengkap.

### Struktur Prompt

LLM2 menerima 4 pesan dalam format LangChain:

1. **SystemMessage** — System prompt dari `python/systemprompt.txt` dengan template variables:
   - `{{prompt_override}}` — Prompt kustom dari perintah `/prompt`.
   - `{{assistant_name}}` — Nama tampilan bot.

2. **HumanMessage** — Deskripsi grup:
   ```
   Group description:
   <deskripsi grup>
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

4. **HumanMessage** — History dan pesan terkini:
   ```
   older messages:
   <000120>[14:30]Alice (u8k2d1):Halo semua
   <000121>[14:31]Bob (u1m9qa):Hai juga

   current messages(burst):
   <000122>[14:35]Alice (u8k2d1):@Bot tolong bantu dong
   ```

### Multimodal Support

Jika `LLM2_ENABLE_MEDIA_INPUT=1` (default), pesan ke-4 bisa berisi blok gambar:

- Maks `LLM_MEDIA_MAX_ITEMS` attachment (default: 2).
- Maks `LLM_MEDIA_MAX_BYTES` total size (default: 5 MB).
- Jika multimodal gagal, otomatis fallback ke text-only prompt.

### Retry & Fallback

```
Primary provider → gagal → retry (jika timeout, max LLM2_RETRY_MAX kali)
                          → text-only fallback (jika bukan timeout)
                          → fallback provider (jika dikonfigurasi)
```

### Result Validation

Caller bisa memberikan `result_validator` function. Jika validasi gagal, result dianggap unusable dan fallback provider dicoba.

## Slash Commands

Slash command (mis. `/prompt`, `/reset`, `/permission`, `/broadcast`) **tidak lagi ditangani oleh bridge**. Seluruh dispatch perintah kini berada di sisi Node gateway (`src/wa/command/` untuk infrastruktur `CommandRegistry`/`CommandContext` dan `src/wa/commands/` untuk handler per-perintah). Tidak ada lagi modul `commands.py` di sisi Python.

Bridge hanya menerima sinkronisasi state setelah perintah dieksekusi gateway, melalui control event (`clear_history`, `invalidate_chat_settings`, `set_llm2_model`, `set_subagent_enabled`, dll.). Lihat [Protokol WebSocket](./protokol) untuk detailnya.

## Database (`db/`)

State per-tenant disimpan di package `db/`: repository per-domain (`settings_repository.py`, `models_repository.py`, `moderation_repository.py`, `stats_repository.py`, `activation_repository.py`) di atas core per-tenant (`core.py`). Tidak ada lagi modul `db.py` monolitik.

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

- Read melalui in-memory cache (`dict`) — LLM pipeline tidak pernah hit SQLite langsung.
- Write melalui SQLite lalu invalidate cache.
- Thread-safe dengan `threading.Lock`.
- Koneksi thread-local (satu per thread).
- WAL mode untuk performa concurrent read.

### Permission Levels

| Level | Delete | Mute | Kick | Deskripsi |
|-------|--------|------|------|-----------|
| 0 | Tidak | Tidak | Tidak | Default — moderasi dinonaktifkan |
| 1 | Ya | Tidak | Tidak | Hanya delete pesan |
| 2 | Ya | Ya | Tidak | Delete + mute member |
| 3 | Ya | Ya | Ya | Moderasi penuh (delete + mute + kick) |

## History (`history.py`)

### WhatsAppMessage Dataclass

```python
@dataclass
class WhatsAppMessage:
    timestamp_ms: int
    sender: str                     # Display name atau phone
    context_msg_id: str | None      # 6 digit ID
    sender_ref: str | None          # Short reference
    sender_is_admin: bool
    text: str | None
    media: str | None               # "image", "video", "sticker", dll.
    quoted_message_id: str | None
    quoted_sender: str | None
    quoted_text: str | None
    quoted_media: str | None
    message_id: str | None
    role: str                       # "user" | "assistant"
```

### Format History

```
<000120>[14:30]Alice (u8k2d1):Halo semua
<000121>[14:31][Admin]Bob (u1m9qa):Peraturan grup diperbarui
  > reply_to: from=Alice | id=000120 | quoted_text=Halo semua
<pending>[14:32]LLM (You):Halo! Ada yang bisa dibantu?
```

Format: `<contextMsgId>[HH:MM][Admin?]NamaSender (senderRef):Teks`

## Media Processing (`media/`)

Package `media/` memproses attachment visual untuk input multimodal ke LLM (`resolver.py` me-resolve path media dari `context_msg_id`, `visual.py` memproses attachment visual):

- Membaca file dari path lokal.
- Encode ke base64 untuk API multimodal.
- Batasi jumlah dan ukuran (`LLM_MEDIA_MAX_ITEMS`, `LLM_MEDIA_MAX_BYTES`).
- Redact multimodal content untuk logging (replace base64 dengan placeholder).

## Logging (`log.py`)

### Structured Logging

- Menggunakan `contextvars` untuk chat-scoped context (chatId, chatName).
- Format: `[LEVEL][timestamp][chat_label] message extras=...`
- Chat label fixed-width (konfigurasi via `BRIDGE_LOG_CHAT_LABEL_WIDTH`).

### Helper Functions

| Fungsi | Deskripsi |
|--------|-----------|
| `setup_logging()` | Konfigurasi logger dengan level dan format |
| `set_chat_log_context(chat_id, chat_name)` | Set context untuk log |
| `reset_chat_log_context()` | Reset context |
| `trunc(text, limit)` | Truncate teks untuk log |
| `dump_json(obj)` | Serialize objek ke JSON untuk log |
| `env_flag(name)` | Cek env variable sebagai boolean flag |

## Konvensi Kode

- Python 3.10+ dengan `from __future__ import annotations`.
- Type hints digunakan di seluruh kode.
- Dataclass untuk struktur data.
- Relative imports dalam package `python/bridge/`.
- Async/await untuk operasi I/O (WebSocket, LLM calls).
