---
sidebar_position: 3
---

# Node.js Gateway

Dokumentasi internal untuk Node.js Gateway (`src/`). Gateway menghubungkan WhatsApp ke Python bridge melalui WebSocket.

## Tech Stack

- **Runtime:** Node.js 18+ dengan ESM (`"type": "module"`)
- **WhatsApp Library:** Baileys v7 (`baileys@7.0.0-rc.9`)
- **WebSocket:** `ws` library
- **Logging:** Pino (structured JSON logging)
- **File System:** `fs-extra`

## Entry Point (`index.js`)

File `index.js` adalah bootstrap utama:

1. Validasi `LLM_WS_ENDPOINT` ada di environment.
2. Jalankan `startWhatsApp()` untuk koneksi WhatsApp.
3. Listen event `message` dari WebSocket client.
4. Routing command dari bridge ke fungsi WhatsApp yang sesuai.

```js
// Alur routing command
wsClient.on('message', async (msg) => {
  switch (msg.type) {
    case 'send_message':    → sendOutgoing(payload)
    case 'react_message':   → reactToMessage(payload)
    case 'delete_message':  → deleteMessageByContextId(payload)
    case 'kick_member':     → kickMembers(payload)
    case 'mark_read':       → markChatRead(payload)
    case 'send_presence':   → sendPresence(payload)
  }
});
```

Setiap aksi mengembalikan `action_ack` ke bridge. Untuk `send_message`, juga mengirim `send_ack` legacy.

## WhatsApp Client (`connection.js`)

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

Token `@everyone (everyone)` di-resolve menjadi mention semua anggota grup.

## Message Parser (`messageParser.js`)

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

## Identifiers (`identifiers.js`)

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

## Media Handler (`mediaHandler.js`)

### Alur Download

1. Terima stream media dari Baileys.
2. Validasi MIME type.
3. Simpan ke `MEDIA_DIR` (`data/media/`).
4. Kembalikan metadata (kind, mime, fileName, size, path).

### Keamanan

- Path media di-sandbox ke `MEDIA_DIR` — tidak bisa directory traversal.
- Ukuran file dibatasi untuk menghindari OOM.

## Caches (`caches.js`)

| Cache | Tipe | Maks Size | TTL |
|-------|------|-----------|-----|
| `messageCache` | `Map<messageId, rawMsg>` | 5000 | - |
| `messageKeyIndex` | `Map<chatId::contextMsgId, entry>` | 10000 | - |
| `messageIdToContextId` | `Map<chatId::messageId, contextMsgId>` | 20000 | - |
| `contextCounterByChat` | `Map<chatId, counter>` | - | - |
| `senderRefRegistryByChat` | `Map<chatId, registry>` | - | - |
| Group metadata | Via `groupContext.js` | - | 60 detik |

## Group Context (`groupContext.js`)

### Metadata Caching

Metadata grup (nama, deskripsi, partisipan) di-cache dengan TTL 60 detik. Setelah expire, di-fetch ulang dari WhatsApp.

## WebSocket Client (`wsClient.js`)

- Extends `EventEmitter`.
- Auto-reconnect saat koneksi putus (interval konfigurasi via `WS_RECONNECT_MS`).
- Mengirim `hello` message saat connect dengan `instanceId` dan `role`.
- Support `Authorization: Bearer <token>` header.

## Konvensi Kode

- ESM modules (`import`/`export`).
- 2-space indentation, single quotes.
- Async/await untuk semua operasi asynchronous.
- Structured logging via `logger` dengan objek konteks.
- Tidak ada formatter/linter — ikuti style yang ada dan minimalkan diff.
