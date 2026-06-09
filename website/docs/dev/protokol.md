---
sidebar_position: 5
---

# Protokol WebSocket

Gateway dan bridge berkomunikasi melalui pesan JSON via WebSocket. Halaman ini mendokumentasikan semua tipe pesan dan payload-nya.

## Koneksi

1. Gateway connect ke bridge di URL yang dikonfigurasi (`LLM_WS_ENDPOINT`).
2. Jika `LLM_WS_TOKEN` diset, gateway mengirim header `Authorization: Bearer <token>`.
3. Setelah connect, gateway mengirim pesan `hello`:

```json
{
  "type": "hello",
  "payload": {
    "instanceId": "dev-gateway-1",
    "role": "whatsapp-gateway"
  }
}
```

4. Jika koneksi putus, gateway auto-reconnect setelah `WS_RECONNECT_MS` (default 5 detik).

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

**Error codes:** `not_found`, `not_group`, `permission_denied`, `invalid_target`, `send_failed`.

## Bridge → Gateway

### `send_message`

Kirim pesan ke chat WhatsApp.

```json
{
  "type": "send_message",
  "payload": {
    "requestId": "req-send-001",
    "chatId": "12345@g.us",
    "text": "Hai @whoami (u8k2d1), selamat datang! @everyone (everyone)",
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
| `@everyone (everyone)` | Mention semua anggota grup |

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

## Legacy Compatibility

| Event | Deskripsi |
|-------|-----------|
| `send_ack` | Masih dikirim untuk `send_message` yang berhasil |
| `error` | Dikirim untuk kegagalan command dengan `code` yang stabil |

## Keamanan Protokol

### Moderasi Gating

Bridge menerapkan gating untuk aksi moderasi berdasarkan level permission yang diatur via perintah `/permission`:

- `DELETE` hanya dieksekusi jika permission level mengizinkan (level 1 atau 3) **DAN** bot adalah admin.
- `KICK` hanya dieksekusi jika permission level mengizinkan (level 2 atau 3) **DAN** bot adalah admin.

Permission dikelola menggunakan perintah `/permission <0-3>` dan disimpan di database per-chat.

### senderRef Isolation

JID asli tidak pernah dikirim ke LLM. Semua referensi user menggunakan `senderRef` yang merupakan hash deterministik pendek.

## Implementasi Custom Bridge

Untuk mengimplementasikan bridge kustom, Anda perlu:

1. **WebSocket server** yang listen di endpoint yang dikonfigurasi.
2. **Handle `incoming_message`** — terima dan proses pesan.
3. **Kirim command** — gunakan format di atas untuk mengirim aksi.
4. **Handle `action_ack`/`error`** — track status aksi.

Contoh minimal ada di `examples/llm_ws_echo.py`.
