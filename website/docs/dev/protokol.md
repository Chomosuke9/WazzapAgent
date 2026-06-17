---
sidebar_position: 5
---

# Protokol WebSocket

Gateway dan bridge berkomunikasi melalui pesan JSON via WebSocket. Halaman ini mendokumentasikan semua tipe pesan dan payload-nya.

## Koneksi

1. Python `WaSocket` (client) men-dial Node gateway (server) di `NODE_URL` (default `ws://localhost:3000`). Node mengikat WS server-nya ke `WS_BIND_HOST:WS_LISTEN_PORT` (default `127.0.0.1:3000`).
2. Jika `LLM_WS_TOKEN` diset, client mengirim header `Authorization: Bearer <token>` (diverifikasi oleh Node).
3. Setelah connect, client mengirim pesan `hello` berisi `folderPath` tenant-nya; Node membalas `hello_ack`:

```json
{
  "type": "hello",
  "payload": {
    "folderPath": "/tenants/acct-a",
    "protocolVersion": "2.0"
  }
}
```

```json
{
  "type": "hello_ack",
  "payload": {
    "folderPath": "/tenants/acct-a",
    "waStatus": "open"
  }
}
```

4. Jika koneksi putus, client auto-reconnect dengan exponential backoff (`WS_RECONNECT_MS`, default 5 detik).

Setelah handshake, **action** mengalir Python→Node, sedangkan **event, control event, dan ack** mengalir Node→Python. Setiap frame Node→Python membawa `folderPath` untuk routing tenant.

## Gateway → Bridge

### `incoming_message`

Dikirim setiap kali ada pesan masuk di WhatsApp.

```json
{
  "type": "incoming_message",
  "payload": {
    "contextMsgId": "000125",
    "messageId": "wamid-abc",
    "instanceId": "dev-gateway-1",
    "chatId": "12345@g.us",
    "chatName": "Nama Grup",
    "chatType": "group",
    "senderId": "98765@s.whatsapp.net",
    "senderRef": "u8k2d1",
    "senderName": "Alice",
    "senderIsAdmin": false,
    "senderIsOwner": false,
    "isGroup": true,
    "botIsAdmin": true,
    "botIsSuperAdmin": false,
    "fromMe": false,
    "contextOnly": false,
    "triggerLlm1": false,
    "timestampMs": 1738560000000,
    "messageType": "extendedTextMessage",
    "text": "Halo semua",
    "quoted": {
      "messageId": "wamid-quoted",
      "contextMsgId": "000124",
      "senderId": "555@s.whatsapp.net",
      "senderName": "Bob",
      "text": "Pesan sebelumnya",
      "type": "conversation"
    },
    "attachments": [
      {
        "kind": "image",
        "mime": "image/jpeg",
        "fileName": "wamid_image.jpg",
        "size": 12345,
        "path": "data/media/wamid_image.jpg",
        "isAnimated": false
      }
    ],
    "mentionedJids": ["123@s.whatsapp.net"],
    "mentionedParticipants": [
      {
        "jid": "123@s.whatsapp.net",
        "senderRef": "u1m9qa",
        "name": "Bob"
      }
    ],
    "botMentioned": false,
    "repliedToBot": false,
    "location": null,
    "groupDescription": "Deskripsi grup",
    "slashCommand": null
  }
}
```

#### Field Penting

| Field | Tipe | Deskripsi |
|-------|------|-----------|
| `contextMsgId` | `string` | Counter 6 digit per chat (`000000`–`999999`) |
| `senderRef` | `string` | ID pendek deterministik per sender, **bukan JID** |
| `contextOnly` | `boolean` | `true` untuk pesan bot sendiri (enrichment, tidak trigger LLM) |
| `triggerLlm1` | `boolean` | Apakah pesan harus melewati LLM1 gating |
| `botMentioned` | `boolean` | Bot di-mention dalam pesan |
| `repliedToBot` | `boolean` | Pesan reply ke pesan bot |
| `senderIsOwner` | `boolean` | Sender adalah bot owner (dari `BOT_OWNER_JIDS`) |
| `slashCommand` | `object\|null` | `{ command, args }` jika pesan adalah slash command |
| `messageType` | `string` | Tipe pesan Baileys (bisa `"actionLog"` untuk synthetic event) |

#### Catatan

- Pesan bot dikirim sebagai `contextOnly: true` dan `triggerLlm1: false`.
- Gateway bisa emit synthetic event `messageType: "actionLog"` setelah aksi moderasi berhasil.
- `mentionedParticipants` meng-resolve JID menjadi `{ jid, senderRef, name }`.
### `action_ack`

Dikirim sebagai respons setiap kali aksi dari bridge berhasil/gagal.

```json
{
  "type": "action_ack",
  "payload": {
    "requestId": "req-del-001",
    "action": "delete_message",
    "ok": true,
    "detail": "deleted",
    "result": {
      "contextMsgId": "000125",
      "messageId": "wamid-abc"
    }
  }
}
```

#### Error Format

Saat aksi gagal, gateway juga mengirim pesan `error`:

```json
{
  "type": "error",
  "payload": {
    "message": "delete_message failed",
    "detail": "message not found in cache",
    "code": "not_found",
    "requestId": "req-del-001",
    "action": "delete_message"
  }
}
```

**Error codes:** `not_found`, `not_group`, `permission_denied`, `invalid_target`, `send_failed`, `timeout`.

## Gateway → Bridge — Control Events

Selain `incoming_message`, gateway mengirim **control event** untuk menyinkronkan state ke bridge. Semua control event bersifat **reliable** — di-queue per akun dan di-flush ulang setelah reconnect. Setiap frame membawa `folderPath` untuk routing tenant.

Handshake awal `hello` (Python→Node, dengan `protocolVersion: "2.0"`) / `hello_ack` (Node→Python) didokumentasikan di [Koneksi](#Koneksi) — juga reliable.

| Tipe | Deskripsi |
|------|-----------|
| `whatsapp_status` | Perubahan status koneksi WhatsApp: `{folderPath, status, reason?, instanceId}` |
| `clear_history` | Hapus riwayat untuk `chatId` atau `"global"` (setelah `/reset`) |
| `set_llm2_model` | Sinkron perubahan model yang otoritatif: `{chatId, modelId}` |
| `invalidate_llm2_model` | Invalidasi cache model untuk `chatId` atau `"global"` |
| `invalidate_default_model` | Invalidasi model default (setelah `/modelcfg`) |
| `invalidate_chat_settings` | Invalidasi setelah perubahan mode/prompt/permission/trigger/idle/announcement |
| `set_subagent_enabled` | Toggle sub-agent per chat: `{chatId, enabled}` |
| `schedule_task` | Tugas terjadwal: `{chatId, taskId, fireAtMs, prompt}` — di-persist, dipicu sekali |

## Bridge → Gateway

### `send_message`

Kirim pesan ke chat WhatsApp.

```json
{
  "type": "send_message",
  "payload": {
    "requestId": "req-send-001",
    "chatId": "12345@g.us",
    "text": "Hai @whoami (u8k2d1), selamat datang! @all (all)",
    "replyTo": "000124",
    "attachments": [
      {
        "kind": "image",
        "path": "data/media/to-send.jpg",
        "caption": "Opsional"
      }
    ]
  }
}
```

#### Mentions

| Syntax | Deskripsi |
|--------|-----------|
| `@Name (senderRef)` | Mention satu user (resolve ke JID) |
| `@all (all)` | Mention semua anggota grup |

Token `@Name (senderRef)` yang invalid akan di-skip (pesan tetap terkirim).

#### Reply

Field `replyTo` menerima `contextMsgId` (6 digit). Gateway me-resolve ke Baileys message key untuk quote.

### `react_message`

Tambah reaksi emoji ke pesan.

```json
{
  "type": "react_message",
  "payload": {
    "requestId": "req-react-001",
    "chatId": "12345@g.us",
    "contextMsgId": "000125",
    "emoji": "👍"
  }
}
```

### `delete_message`

Hapus pesan dari chat (bot harus admin).

```json
{
  "type": "delete_message",
  "payload": {
    "requestId": "req-del-001",
    "chatId": "12345@g.us",
    "contextMsgId": "000125"
  }
}
```

:::warning
`delete_message` berjalan dalam strict mode — jika `contextMsgId` tidak ditemukan di cache, aksi langsung gagal tanpa fallback.
:::

### `kick_member`

Kick member dari grup.

```json
{
  "type": "kick_member",
  "payload": {
    "requestId": "req-kick-001",
    "chatId": "12345@g.us",
    "targets": [
      { "senderRef": "u8k2d1", "anchorContextMsgId": "000125" },
      { "senderRef": "u1m9qa", "anchorContextMsgId": "000124" }
    ],
    "mode": "partial_success",
    "autoReplyAnchor": true
  }
}
```

| Field | Deskripsi |
|-------|-----------|
| `targets[].senderRef` | senderRef target yang akan di-kick |
| `targets[].anchorContextMsgId` | contextMsgId untuk verifikasi identity |
| `mode` | `"partial_success"` — lanjutkan meskipun beberapa target gagal |
| `autoReplyAnchor` | Auto-reply ke pesan anchor setelah kick |

### `mark_read`

Tandai pesan sebagai dibaca (centang biru).

```json
{
  "type": "mark_read",
  "payload": {
    "chatId": "12345@g.us",
    "messageId": "wamid-abc",
    "participant": "98765@s.whatsapp.net"
  }
}
```

`participant` opsional; sertakan untuk pesan grup.

### `send_presence`

Kirim typing indicator.

```json
{
  "type": "send_presence",
  "payload": {
    "chatId": "12345@g.us",
    "type": "composing"
  }
}
```

`type`: `"composing"` (sedang mengetik) atau `"paused"` (berhenti mengetik). Default `"composing"`.

### Aksi Lainnya

Action berikut juga dikirim bridge→gateway (Python→Node). Masing-masing mengembalikan `action_ack`.

| Tipe | Deskripsi | Payload |
|------|-----------|---------|
| `run_command` | Eksekusi slash command secara senyap (tanpa echo ke WhatsApp) | `{chatId, command, contextMsgId?}` |
| `send_quiz` | Kirim kuis pilihan ganda dengan tombol | `{chatId, question, choices[], footer?, replyTo?}` |
| `send_copy_code` | Tombol CTA salin kode | `{chatId, code, displayText?, quotedPreviewText?}` |
| `relay_lottie_sticker` | Relay stiker Lottie dari payload JSON tersimpan | `{chatId, lottiePayload, replyTo?}` |
| `send_buttons` | Tombol NativeFlow generik (legacy) | `{chatId, text, buttons[], footer?}` |
| `send_carousel` | Kartu carousel yang bisa di-swipe | `{chatId, cards[], text?}` |
| `download_media` | Ambil byte media lazy untuk pesan yang sudah diteruskan | `{chatId, contextMsgId? \| messageId?}` |

:::note
`download_media`: inbound hanya meneruskan metadata attachment (`path: null, pending: true`); bridge memanggil aksi ini saat benar-benar butuh byte-nya (vision / stiker / sub-agent). `action_ack.result` membawa `{path, mime, kind, fileName, ...}`, atau `code: not_found` jika proto sumber sudah dievakuasi dari cache.
:::

## Legacy Compatibility

| Event | Deskripsi |
|-------|-----------|
| `send_ack` | Masih dikirim untuk `send_message` yang berhasil |
| `error` | Dikirim untuk kegagalan command dengan `code` yang stabil |

## Keamanan Protokol

### Moderasi Gating

Bridge menerapkan gating untuk aksi moderasi berdasarkan level permission yang diatur via perintah `/permission`:

- `DELETE` hanya dieksekusi jika permission level mengizinkan (level 1, 2, atau 3) **DAN** bot adalah admin.
- `MUTE` hanya dieksekusi jika permission level mengizinkan (level 2 atau 3) **DAN** bot adalah admin.
- `KICK` hanya dieksekusi jika permission level mengizinkan (level 3 saja) **DAN** bot adalah admin.

Permission dikelola menggunakan perintah `/permission <0-3>` dan disimpan di database per-chat.

### senderRef Isolation

JID asli tidak pernah dikirim ke LLM. Semua referensi user menggunakan `senderRef` yang merupakan hash deterministik pendek.

## Implementasi Custom Bridge

Untuk mengimplementasikan bridge kustom, Anda perlu:

1. **WebSocket client** yang men-dial Node gateway (server) di `NODE_URL` dan mengirim `hello { folderPath }`, lalu menunggu `hello_ack`.
2. **Handle `incoming_message`** — terima dan proses pesan.
3. **Kirim action** — gunakan format di atas untuk mengirim aksi (Python→Node).
4. **Handle `action_ack`/`error`** — track status aksi.

Cara termudah adalah memakai SDK `make_wa_socket` (`python/wasocket`).
