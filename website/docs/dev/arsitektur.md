---
sidebar_position: 1
---

# Arsitektur

> Untuk konteks lengkap developer, lihat [AGENTS.md](https://github.com/Chomosuke9/WazzapAgents/blob/main/AGENTS.md) dan [docs/llm-architecture/](https://github.com/Chomosuke9/WazzapAgents/tree/main/docs/llm-architecture).

WazzapAgents terdiri dari dua komponen runtime yang berkomunikasi melalui WebSocket:

```
WhatsApp <──Baileys──> Node.js Gateway <──WebSocket──> Python LLM Bridge <──HTTP──> LLM API
```

## Komponen Utama

### 1. Node.js Gateway (`src/`)

Gateway bertanggung jawab untuk:

- **Koneksi WhatsApp** — Menggunakan Baileys v7 untuk connect ke WhatsApp via multi-device protocol.
- **Parsing pesan** — Mengekstrak teks, media, mentions, quoted messages, lokasi, dan vCard dari pesan Baileys mentah.
- **Forwarding ke bridge** — Mengirim payload `incoming_message` ke Python bridge via WebSocket.
- **Eksekusi aksi** — Menerima command dari bridge (send, react, delete, kick, mark read, typing) dan mengeksekusinya di WhatsApp.
- **Interactive messages** — Mengirim pesan interaktif (button, carousel, list) via `relayMessage` + `additionalNodes`.
- **Caching** — Menyimpan message cache, metadata grup (TTL 60 detik), nama partisipan, dan sender ref registry di memori.

### 2. Python LLM Bridge (`python/bridge/`)

Bridge bertanggung jawab untuk:

- **WebSocket server** — Menerima pesan dari gateway dan mengirim command balik.
- **Message batching** — Mengelompokkan pesan yang masuk dalam burst window dengan debounce logic.
- **Pipeline LLM dua tahap:**
  - **LLM1 (Gating)** — Memutuskan apakah bot harus merespons pesan. Ringan dan cepat.
  - **LLM2 (Responder)** — Menghasilkan respons lengkap dengan konteks percakapan dan system prompt.
- **Slash commands** — Menangani `/prompt`, `/reset`, `/permission` secara langsung.
- **Penyimpanan** — Tiga database SQLite terpisah: `settings.db`, `stats.db`, `moderation.db`.
- **History management** — Menyimpan riwayat percakapan per-chat di memori dengan limit yang dapat dikonfigurasi.

## Alur Data

### Pesan Masuk (User → Bot)

```
1. User mengirim pesan di WhatsApp
2. Baileys menerima event `messages.upsert`
3. Gateway parsing pesan (messageParser.js)
4. Gateway assign contextMsgId & senderRef (identifiers.js)
5. Gateway kirim `incoming_message` ke bridge via WebSocket
6. Bridge batch pesan (debounce 5 detik, max burst 20 detik)
7. Bridge jalankan LLM1 (gating decision)
8. Jika LLM1 memutuskan respond → jalankan LLM2
9. LLM2 generate respons + tool calls
10. Bridge parse aksi dari tool calls LLM2
11. Bridge kirim command ke gateway via WebSocket
12. Gateway eksekusi aksi di WhatsApp, kirim ack/error balik
```

### Pesan Konteks (Bot → Bridge)

Pesan yang dikirim oleh bot sendiri juga diteruskan ke bridge sebagai `contextOnly: true` dan `triggerLlm1: false`. Ini memperkaya konteks percakapan tanpa menyebabkan loop.

## Identifikasi Pesan

### contextMsgId

Counter 6 digit per-chat (`000000`–`999999`, wrap setelah `999999`). Digunakan untuk referensi pesan dalam percakapan — misalnya saat bot perlu reply ke pesan tertentu atau menghapus pesan.

### senderRef

ID pendek deterministik per-pengirim per-chat, di-generate dari SHA-1 hash `chatId|senderId`. Digunakan di semua interaksi LLM — **tidak pernah** mengekspos JID asli ke LLM.

## Penyimpanan Data

| Data | Lokasi | Tipe |
|------|--------|------|
| Session WhatsApp | `data/auth/` | File (Baileys auth state) |
| Media yang diunduh | `data/media/` | File (gambar, video, dll.) |
| Sticker katalog | `data/stickers/` | File (WebP) |
| Pengaturan chat & model | `data/settings.db` | SQLite (WAL mode) |
| Statistik dashboard | `data/stats.db` | SQLite (WAL mode) |
| Mute state | `data/moderation.db` | SQLite (WAL mode) |
| Riwayat percakapan | Memori (RAM) | In-memory deque |
| Message cache | Memori (RAM) | In-memory Map |
| Metadata grup | Memori (RAM) | TTL cache (60 detik) |

> **Catatan:** Database dipisahkan menjadi tiga file SQLite untuk menghindari locking contention. Setiap database menggunakan WAL mode untuk concurrent reads.

## Diagram Modul

### Node.js Gateway

```
src/
├── index.js              ← Bootstrap, routing command dari WS ke aksi WhatsApp
├── wsClient.js           ← WebSocket client ke bridge (auto-reconnect, reliable queue)
├── config.js             ← Environment variable loading
├── logger.js             ← Structured pino logging
├── messageParser.js      ← Parsing pesan Baileys → payload terstruktur
├── mediaHandler.js       ← Download & validasi media
├── identifiers.js        ← contextMsgId counter, senderRef registry
├── participants.js       ← Mapping role partisipan, cache nama
├── groupContext.js       ← Cache metadata grup
├── caches.js             ← In-memory caches (message, metadata, nama)
├── db.js                 ← SQLite via better-sqlite3 (settings, models, stats)
└── wa/
    ├── connection.js     ← Koneksi WhatsApp, lifecycle, button handler
    ├── inbound.js        ← Normalisasi pesan masuk → payload
    ├── outbound.js        ← Kirim teks/media/mentions ke WhatsApp
    ├── actions.js         ← React & delete message wrappers
    ├── moderation.js      ← Kick members
    ├── presence.js        ← Mark read & typing indicator
    ├── commandHandler.js  ← Dispatcher slash command
    ├── commands.js        ← Alias normalization
    ├── events.js          ← Synthetic context events
    ├── utils.js           ← Concurrency helpers
    ├── command/           ← Per-command handler modules
    │   ├── help.js, prompt.js, reset.js, permission.js
    │   ├── mode.js, trigger.js, dashboard.js, model.js
    │   ├── broadcast.js, info.js, debug.js, join.js
    │   ├── sticker.js, modelcfg.js, setting.js
    │   └── groupStatus.js, catch.js
    └── interactive/      ← NativeFlow interactive messages
        ├── sendInteractive.js  ← viewOnce + relayMessage + additionalNodes
        ├── sendButtons.js      ← Quick reply, CTA URL, copy, call buttons
        └── sendCarousel.js     ← Swipeable carousel cards
```

### Python Bridge

```
python/bridge/
├── main.py              ← WebSocket handler, batching, orkestrasi pipeline
├── config.py            ← Parsing env variable, konstanta konfigurasi
├── db.py                ← SQLite storage dengan in-memory cache
├── history.py           ← WhatsAppMessage dataclass, formatting history
├── media.py             ← Pemrosesan attachment visual untuk multimodal
├── stickers.py          ← Sticker catalog scanning (data/stickers/)
├── commands.py           ← Legacy slash command handler (Python side)
├── dashboard.py          ← Stats buffer + periodic flush
├── log.py               ← Structured logging dengan contextvars
├── llm/
│   ├── llm1.py          ← LLM1 gating/decision (should respond / express-only)
│   ├── llm2.py          ← LLM2 response generation + tools
│   ├── schemas.py       ← Tool schemas (JSON Schema / OpenAI function calling)
│   ├── prompt.py         ← System prompt assembly, history, metadata injection
│   ├── client.py         ← LLM client factory, fallback targets
│   ├── metadata.py       ← Context metadata: bot mention, reply signals
│   └── tool_utils.py     ← Cross-provider tool-call extraction
├── messaging/
│   ├── processing.py     ← Burst building, payload normalization
│   ├── filtering.py      ← Trigger check, prefix/trigger mode
│   ├── actions.py         ← Parse action lines dari LLM2 output
│   ├── gateway.py         ← Send actions over WS to Node
│   └── moderation.py      ← Permission checks, payload merge
└── tools/
    └── sticker.py        ← PIL-based sticker creation (text overlay, EXIF)