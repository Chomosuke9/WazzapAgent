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

- **WebSocket client** — Setiap `WaSocket` men-dial Node gateway (server) di `NODE_URL`, mengirim `hello` dengan `folderPath` tenant-nya, lalu menerima event dan mengirim action balik.
- **Message batching** — Mengelompokkan pesan yang masuk dalam burst window dengan debounce logic.
- **Pipeline LLM dua tahap:**
  - **LLM1 (Gating)** — Memutuskan apakah bot harus merespons pesan. Ringan dan cepat.
  - **LLM2 (Responder)** — Menghasilkan respons lengkap dengan konteks percakapan dan system prompt.
- **Slash commands** — Menangani `/prompt`, `/reset`, `/permission` secara langsung.
- **Penyimpanan** — Lima database SQLite terpisah per-tenant di `<folder_path>/db`: `settings.db`, `stats.db`, `moderation.db`, `subagent.db`, `stickers.db`.
- **History management** — Menyimpan riwayat percakapan per-chat di memori dengan limit yang dapat dikonfigurasi.

## Alur Data

### Pesan Masuk (User → Bot)

```
1. User mengirim pesan di WhatsApp
2. Baileys menerima event `messages.upsert`
3. Gateway parsing pesan (wa/domain/messageParser.ts)
4. Gateway assign contextMsgId & senderRef (wa/domain/identifiers.ts)
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
| Session WhatsApp | `<folder_path>/auth/` | File (Baileys auth state) |
| Media yang diunduh | `<folder_path>/media/` | File (gambar, video, dll.) |
| Sticker katalog | `<folder_path>/stickers/` | File (WebP) |
| Pengaturan chat & model | `<folder_path>/db/settings.db` | SQLite (WAL mode) |
| Statistik dashboard | `<folder_path>/db/stats.db` | SQLite (WAL mode) |
| Mute state | `<folder_path>/db/moderation.db` | SQLite (WAL mode) |
| Sub-agent state | `<folder_path>/db/subagent.db` | SQLite (WAL mode) |
| Sticker DB | `<folder_path>/db/stickers.db` | SQLite (WAL mode) |
| Riwayat percakapan | Memori (RAM) | In-memory deque |
| Message cache | Memori (RAM) | In-memory Map |
| Metadata grup | Memori (RAM) | TTL cache (60 detik) |

> **Catatan:** Setiap tenant (`folder_path`) terisolasi penuh di bawah `<folder_path>/{auth,db,media,stickers}`. Database dipisahkan menjadi lima file SQLite untuk menghindari locking contention. Setiap database menggunakan WAL mode untuk concurrent reads.

## Diagram Modul

### Node.js Gateway

```
src/
├── index.ts              ← Composition root: config, WS server, akun per-tenant
├── config.ts             ← Sumber config tunggal — semua pembacaan process.env
├── logger.ts             ← Structured pino logging
├── mediaHandler.ts       ← Download & validasi media, resolusi path
├── server/
│   ├── wsServer.ts        ← WS server: terima client di WS_LISTEN_PORT, heartbeat
│   └── accountRegistry.ts ← Ikat tiap client ke AccountEntry folder_path-nya
├── account/              ← Agregat per-tenant (satu AccountEntry per folder_path)
│   ├── baileysFactory.ts   ← Buat/resume Baileys socket per-tenant; owns DB + repos
│   ├── accountContext.ts   ← Cache/identifier/sendQueue/forwarder/repos per-akun
│   ├── actionDispatcher.ts ← Dispatch action Python→Node (handler per-action)
│   └── eventForwarder.ts   ← Forward event Node→Python (reliableQueue per-akun)
├── db/                   ← SQLite per-tenant (tanpa handle global modul)
│   ├── Database.ts         ← Owns koneksi satu tenant (open/recover/migrate/close)
│   ├── schema/            ← Pembuatan tabel + migrasi
│   └── repositories/      ← Settings, Stats, Model, Activation repositories
├── protocol/
│   ├── types.ts           ← Wire types: frame, WaStatus, AccountEntry, payload
│   └── ports.ts           ← Interface pemutus siklus account/↔wa/
└── wa/                   ← Modul WhatsApp
    ├── domain/            ← caches, identifiers, participants, groupContext, messageParser
    ├── connection.ts      ← Lifecycle Baileys v7, button handler
    ├── inbound.ts         ← Pesan masuk → payload incoming_message ternormalisasi
    ├── outbound.ts        ← Kirim teks/media/mentions
    ├── actions.ts         ← React & delete message wrappers
    ├── moderation.ts      ← Kick members
    ├── presence.ts        ← Mark read & typing indicator
    ├── events.ts          ← Synthetic context events
    ├── sendQueue.ts       ← Antrian kirim per-JID (urutan pesan)
    ├── command/           ← Dispatch command bertipe (CommandRegistry + CommandContext)
    ├── commands/          ← Modul handler per-command
    └── interactive/       ← Pesan interaktif NativeFlow
```

### Python Bridge

```
python/
├── wasocket/             ← SDK make_wa_socket (WS CLIENT)
│   ├── socket.py          ← Class WaSocket + factory make_wa_socket
│   ├── transport.py       ← WSClientTransport: dial NODE_URL, reconnect, heartbeat
│   ├── protocol.py / events.py     ← Dataclass frame + model WhatsAppMessage
│   └── correlation.py / errors.py  ← Korelasi requestId + hierarki error
└── bridge/
    ├── main.py            ← Boot: load akun, jalankan satu AgentSession per akun
    ├── accounts.py         ← Loader konfigurasi multi-account
    ├── config.py           ← Sumber config tunggal (env, konstanta)
    ├── session.py          ← AgentSession: composition root (wiring collaborators agent/)
    ├── history.py          ← WhatsAppMessage dataclass, formatting history
    ├── dashboard.py        ← Stats buffer + periodic flush
    ├── stickers.py / sticker_db.py ← Sticker catalog + sticker DB per-tenant
    ├── agent/              ← Collaborator per-akun yang injectable
    ├── db/                 ← Repository per-domain di atas core per-tenant
    ├── media/              ← Resolusi media + sticker
    ├── llm/                ← Pipeline LLM (llm1, llm2, schemas, prompt, client, ...)
    ├── messaging/          ← Pipeline pemrosesan pesan
    ├── tools/              ← Implementasi tool (pembuatan sticker PIL)
    └── subagent/           ← Integrasi sub-agent
```