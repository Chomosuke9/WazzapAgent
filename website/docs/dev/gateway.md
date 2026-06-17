---
sidebar_position: 3
---

# Node.js Gateway

Dokumentasi internal untuk Node.js Gateway (`src/`, TypeScript). Gateway adalah **WebSocket server**: ia mem-bind `WS_BIND_HOST:WS_LISTEN_PORT` (default `127.0.0.1:3000`), dan tiap Python `WaSocket` adalah **client** yang men-dial masuk di `NODE_URL` (default `ws://localhost:3000`) untuk menjembatani WhatsApp ke pipeline LLM.

## Tech Stack

- **Runtime:** Node.js 18+ dengan ESM (`"type": "module"`)
- **WhatsApp Library:** Baileys v7 (`baileys@7.0.0-rc12`)
- **WebSocket:** `ws` library
- **Logging:** Pino (structured JSON logging)
- **File System:** `fs-extra`

## Entry Point (`index.ts`)

File `index.ts` adalah composition root utama:

1. Membaca konfigurasi dan mem-bind WebSocket **server** di `WS_BIND_HOST:WS_LISTEN_PORT` (default `127.0.0.1:3000`).
2. Untuk tiap tenant `folder_path`, membuat/melanjutkan socket Baileys per akun.
3. Menerima koneksi dari Python `WaSocket` client yang men-dial masuk di `NODE_URL`, lalu mengikatnya ke akun via registry setelah handshake `hello`/`hello_ack`.
4. Routing **action** dari bridge (Python→Node) ke fungsi WhatsApp yang sesuai, per akun via `src/account/actionDispatcher.ts`.

```js
// Action dispatch (Python → Node), per akun via src/account/actionDispatcher.ts
'send_message'          → sendOutgoing(payload)
'react_message'         → reactToMessage(payload)
'delete_message'        → deleteMessageByContextId(payload)
'kick_member'           → kickMembers(payload)
'mark_read'             → markChatRead(payload)
'send_presence'         → sendPresence(payload)
'run_command'           → runCommand(payload)
'send_quiz' / 'send_copy_code' / 'relay_lottie_sticker'
'send_buttons' / 'send_carousel'
```

Setiap aksi mengembalikan `action_ack` ke bridge (Node→Python). Untuk `send_message`, juga mengirim `send_ack` legacy. Setiap frame Node→Python membawa `folderPath` untuk routing tenant.

## WhatsApp Client (`src/wa/connection.ts`)

### Koneksi

Menggunakan `makeWASocket` dari Baileys dengan auth state yang disimpan di `data/auth/`. Saat pertama kali, menampilkan QR code di terminal.

### Event Handling

- **`messages.upsert`** — Event utama saat pesan masuk. Setiap pesan di-parse, di-assign contextMsgId, dan dikirim ke bridge.
- **`group-participants.update`** — Mendeteksi anggota baru masuk/keluar grup.
- **`connection.update`** — Mengelola status koneksi dan reconnection.

### Aksi Moderasi

| Fungsi | Deskripsi |
|--------|-----------|
| `sendOutgoing(payload)` | Kirim pesan teks/media dengan support mentions dan reply |
| `reactToMessage(payload)` | Tambah reaksi emoji ke pesan |
| `deleteMessageByContextId(payload)` | Hapus pesan berdasarkan contextMsgId |
| `kickMembers(payload)` | Kick member dari grup (support `partial_success` mode) |
| `markChatRead(payload)` | Tandai pesan sebagai dibaca (centang biru) |
| `sendPresence(payload)` | Kirim typing indicator (`composing`/`paused`) |

### Mention Resolution

Saat mengirim pesan, gateway me-resolve token `@Name (senderRef)` di teks menjadi JID WhatsApp yang valid:

```
Teks input:  "Hai @whoami (u8k2d1), jangan spam ya"
Resolusi:    senderRef "u8k2d1" → JID "628123456789@s.whatsapp.net"
Teks output: "Hai @628123456789, jangan spam ya" (dengan mention tag)
```

Token `@all (all)` di-resolve menjadi mention semua anggota grup.

## Message Parser (`src/wa/domain/messageParser.ts`)

Parser mengekstrak informasi terstruktur dari raw Baileys message:

### Data yang Diekstrak

| Field | Sumber |
|-------|--------|
| `text` | `conversation`, `extendedTextMessage`, caption media, reaksi, contact, interactive |
| `quoted` | `contextInfo.quotedMessage` — sender, teks, tipe, lokasi |
| `mentionedJids` | `contextInfo.mentionedJid` |
| `location` | `locationMessage`, `liveLocationMessage` |
| `attachments` | Hasil download media (image, video, audio, document, sticker) |

### Urutan Ekstraksi Teks

Parser mencoba sumber teks dalam urutan prioritas:

1. `conversation` (pesan teks biasa)
2. `extendedTextMessage.text` (teks dengan formatting/link)
3. Interactive responses (button, template, list)
4. Caption media (image/video/document)
5. Reaksi → `react:{emoji}`
6. Contact → `<contact: Name, Phone>`
7. Media placeholder → `<media:image>`, `<media:video>`, dll.

## Identifiers (`src/wa/domain/identifiers.ts`)

### contextMsgId

- Counter 6 digit per chat: `000000` sampai `999999`.
- Increment setiap pesan baru di chat tersebut.
- Wrap kembali ke `000000` setelah `999999`.
- Disimpan di `contextCounterByChat` Map.
- Diindeks di `messageKeyIndex` untuk lookup cepat.

### senderRef

- ID pendek 6 karakter per sender per chat.
- Di-generate dari SHA-1 hash: `sha1(chatId|senderId|attempt)` → base36, 6 chars.
- Collision handling: retry dengan increment `attempt` (max 128 percobaan).
- Registry per chat: `senderToRef`, `refToSender`, `senderToParticipant`.
- **Tujuan:** Memastikan JID asli tidak pernah terekspos ke LLM.

## Media Handler (`src/mediaHandler.ts`)

### Alur Download

1. Terima stream media dari Baileys.
2. Validasi MIME type.
3. Simpan ke `MEDIA_DIR` (`data/media/`).
4. Kembalikan metadata (kind, mime, fileName, size, path).

### Keamanan

- Path media di-sandbox ke `MEDIA_DIR` — tidak bisa directory traversal.
- Ukuran file dibatasi untuk menghindari OOM.

## Caches (`src/wa/domain/caches.ts`)

| Cache | Tipe | Maks Size | TTL |
|-------|------|-----------|-----|
| `messageCache` | `Map<messageId, rawMsg>` | 5000 | - |
| `messageKeyIndex` | `Map<chatId::contextMsgId, entry>` | 10000 | - |
| `messageIdToContextId` | `Map<chatId::messageId, contextMsgId>` | 20000 | - |
| `contextCounterByChat` | `Map<chatId, counter>` | - | - |
| `senderRefRegistryByChat` | `Map<chatId, registry>` | - | - |
| Group metadata | Via `groupContext.ts` | - | 60 detik |

## Group Context (`src/wa/domain/groupContext.ts`)

### Metadata Caching

Metadata grup (nama, deskripsi, partisipan) di-cache dengan TTL 60 detik. Setelah expire, di-fetch ulang dari WhatsApp.

## WebSocket Server (`src/server/wsServer.ts`)

Setelah migrasi, topologi **dibalik**: **Node adalah WebSocket server**, bukan client. Tiap Python `WaSocket` adalah client yang men-dial Node di `NODE_URL` (default `ws://localhost:3000`).

- Mem-bind server `ws` di `WS_BIND_HOST:WS_LISTEN_PORT` (default `127.0.0.1:3000`).
- Menerima koneksi client dan menjalankan heartbeat per-koneksi (`WS_HEARTBEAT_INTERVAL_MS`).
- Mendukung bearer token opsional via `LLM_WS_TOKEN` (diperiksa Node, dikirim oleh client Python).
- `src/server/accountRegistry.ts` mengikat tiap client ke `folder_path`-nya setelah handshake `hello` (Python→Node, `{folderPath, protocolVersion: "2.0"}`) / `hello_ack` (Node→Python, `{folderPath, waStatus}`).

Setelah handshake: **action** mengalir Python→Node; **event**, control event, dan ack mengalir Node→Python. Setiap frame Node→Python membawa `folderPath` untuk routing tenant.

> Urutan start: jalankan **gateway Node lebih dulu** (server), lalu bridge Python (client men-dial masuk).

## Konvensi Kode

- ESM modules (`import`/`export`).
- 2-space indentation, single quotes.
- Async/await untuk semua operasi asynchronous.
- Structured logging via `logger` dengan objek konteks.
- Tidak ada formatter/linter — ikuti style yang ada dan minimalkan diff.
