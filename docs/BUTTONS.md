# WhatsApp Interactive Buttons Guide

> **Referensi implementasi:** Semua fungsi interactive message ada di `src/wa/interactive/` — dokumentasi teknis detail (proto wrapper, binary nodes, error codes) di `src/wa/interactive/README.md`.  
> Lihat [`AGENTS.md`](../AGENTS.md) untuk arsitektur sistem secara keseluruhan.

## Daftar Isi

- [Button Types](#button-types)
- [Sending Multiple Buttons](#sending-multiple-buttons)
- [sendRichMessage — Fungsi Universal](#sendrichmessage--fungsi-universal)
- [Processing Button Clicks](#processing-button-clicks)
- [Button ID Naming Convention](#button-id-naming-convention)
- [Handling Button Responses](#handling-button-responses)
- [Quiz System](#quiz-system)
- [Common Mistakes](#common-mistakes)
- [Full Example: Settings Menu](#full-example-settings-menu)
- [Carousel (Eksperimental)](#carousel-eksperimental)
- [LLM Reply Integration](#llm-reply-integration)
- [Testing Buttons](#testing-buttons)

## Button Types

### 1. quick_reply
Sends a text message when clicked. Used for simple actions.

```javascript
{
  name: 'quick_reply',
  buttonParamsJson: JSON.stringify({
    display_text: 'Get Prompt',
    id: '/prompt'
  })
}
```

**Important:** The `id` field can be:
- A slash command (e.g., `/prompt`, `/model gpt-4o`) - will be parsed as a command
- Any other string - will be returned as `selectedId` in button response

### 2. cta_url
Opens a URL when clicked.

```javascript
{
  name: 'cta_url',
  buttonParamsJson: JSON.stringify({
    display_text: 'Visit Website',
    url: 'https://example.com',
    merchant_url: 'https://example.com/merchant'  // optional
  })
}
```

### 3. cta_copy
Copies text to clipboard when clicked.

```javascript
{
  name: 'cta_copy',
  buttonParamsJson: JSON.stringify({
    display_text: 'Copy Code',
    copy_code: 'PROMO2024'
  })
}
```

### 4. cta_call
Dials a phone number when clicked.

```javascript
{
  name: 'cta_call',
  buttonParamsJson: JSON.stringify({
    display_text: 'Call Support',
    phone_number: '+6281234567890'
  })
}
```

### 5. single_select (Dropdown Menu)
Opens a dropdown with sections and rows.

```javascript
{
  name: 'single_select',
  buttonParamsJson: JSON.stringify({
    title: 'Change Model',
    sections: [
      {
        title: 'Select Model',
        rows: [
          {
            id: 'model_select:gpt-4o',
            title: 'GPT-4o',
            description: 'Fast and capable'
          },
          {
            id: 'model_select:gpt-4o-mini',
            title: 'GPT-4o Mini',
            description: 'Lightweight model'
          }
        ]
      }
    ]
  })
}
```

**CRITICAL:** Each row MUST have `id` field (NOT `rowId`). The `id` value is what gets returned when user clicks that row.

## Sending Multiple Buttons

WhatsApp NativeFlow supports multiple buttons in one message:

```javascript
const buttons = [
  {
    name: 'quick_reply',
    buttonParamsJson: JSON.stringify({
      display_text: 'Get Prompt',
      id: '/prompt'
    })
  },
  {
    name: 'single_select',
    buttonParamsJson: JSON.stringify({
      title: 'Change Model',
      sections: [...]
    })
  },
  {
    name: 'single_select',
    buttonParamsJson: JSON.stringify({
      title: 'Set Permission',
      sections: [...]
    })
  }
];

await sendNativeFlow(sock, chatId, 'Chat Settings', buttons, { footer: 'Click a button' });
```

**Catatan:** `sendNativeFlow` tidak memiliki opsi `badge` — badge AI selalu aktif. Untuk mengontrol badge, gunakan `sendRichMessage` dengan opsi `badge: false`.

### sendCombinedButtons — Mixed Button Types

Use `sendCombinedButtons` to mix different button types (reply, URL, copy, call) in one message:

```javascript
await sendCombinedButtons(sock, jid, 'Pilih aksi:', [
  { type: 'reply', displayText: 'Konfirmasi', id: 'confirm' },
  { type: 'url',   displayText: 'Detail', url: 'https://example.com' },
  { type: 'call',  displayText: 'Telepon', phoneNumber: '+6281234567890' }
]);
```

Supported types: `url`, `reply`, `copy`, `call`. Lihat `src/wa/interactive/sendInteractive.ts`.

## sendRichMessage — Fungsi Universal

`sendRichMessage` adalah fungsi utama untuk mengirim pesan dengan footer, header opsional, dan tombol. Fungsi ini digunakan sebagai default untuk semua reply LLM (lihat [LLM Reply Integration](#llm-reply-integration)).

```javascript
// Pesan teks dengan footer
await sendRichMessage(sock, chatId, {
  text: 'Halo!',
  footer: 'Pesan ini dibuat oleh AI',
});

// Dengan tombol
await sendRichMessage(sock, chatId, {
  title: 'Konfirmasi',
  text: 'Lanjutkan pesanan?',
  footer: 'Tap tombol di bawah',
  buttons: [
    { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Ya', id: 'yes' }) },
    { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Tidak', id: 'no' }) },
  ],
});
```

**Parameter lengkap** `sendRichMessage(sock, jid, options)`:

| Field | Type | Keterangan |
|-------|------|------------|
| `text` | `string` | Body pesan (wajib) |
| `title` | `string` | Header bold (opsional) |
| `subtitle` | `string` | Header subtitle (opsional, NativeFlow header) |
| `image` | `{url: string}` | Gambar header (opsional, mutual eksklusif dengan `video`) |
| `video` | `{url: string}` | Video header (opsional, mutual eksklusif dengan `image`) |
| `footer` | `string` | Footer teks (opsional) |
| `buttons` | `Array` | Array tombol `{name, buttonParamsJson}` (opsional) |
| `badge` | `boolean` | Tampilkan badge AI di private chat (default `true`, nonaktif dengan `false`) |
| `quoted` | `object` | Pesan yang di-reply (opsional) |

```javascript
// Contoh dengan semua parameter
await sendRichMessage(sock, chatId, {
  title: '📢 Pengumuman',
  subtitle: 'Info penting',
  image: { url: 'https://example.com/img.jpg' },
  text: 'Server down 23:00–01:00 WIB.',
  footer: 'Mohon maaf atas ketidaknyamanan',
  buttons: [
    { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'OK', id: 'ok' }) },
  ],
  badge: true,
});
```

**Dokumentasi lengkap** (proto wrapper, binary nodes, mentions, badge AI): `src/wa/interactive/README.md`.

## Processing Button Clicks

When a user clicks a button, the message contains:

### For quick_reply:
```javascript
msg.message.buttonsResponseMessage.selectedButtonId
// Example: "/prompt" or "my_custom_id"
```

### For single_select (NativeFlow):
```javascript
// NativeFlow single_select responses arrive via nativeFlowResponseMessage.paramsJson (JSON string)
// NOT via singleSelectReply — that only lives on listResponseMessage
const paramsJson = msg.message.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
const params = JSON.parse(paramsJson); // { id: "model_select:gpt-4o", ... }
// Example id: "model_select:gpt-4o"
```

### For list (legacy listMessage):
```javascript
msg.message.listResponseMessage.singleSelectReply.selectedRowId
// Example: "model_select:gpt-4o"
```

### For template buttons:
```javascript
msg.message.templateButtonReplyMessage.selectedId
// Example: "/prompt"
```

## Button ID Naming Convention

Use prefixes to organize button IDs:

| Prefix | Purpose |
|--------|---------|
| `/` | Slash commands (e.g., `/prompt`, `/model gpt-4o`) |
| `model_select:` | Select a model |
| `modelcfg:` | Model configuration actions |
| `settings:` | Settings menu actions |
| `qz:` | Quiz button replies (forwarded to LLM as plain text) |

### Examples:

```
/prompt                    → slash command
/model gpt-4o             → slash command with args
model_select:gpt-4o       → select model
modelcfg:list              → modelcfg list action
modelcfg:add               → modelcfg add action
modelcfg:default:gpt-4o    → set default model
modelcfg_remove:gpt-4o    → remove model confirmation
settings:prompt            → settings prompt action
qz:Ya                     → quiz answer "Ya"
```

## Handling Button Responses

The actual handler in `src/wa/connection.ts` covers all button response types:

```javascript
async function handleButtonResponse(msg, chatId, senderId) {
  const buttonsResponse = msg?.message?.buttonsResponseMessage;
  const listResponse = msg?.message?.listResponseMessage;
  const interactiveResponse = msg?.message?.interactiveResponseMessage;

  // Parse NativeFlow paramsJson (used by quick_reply & single_select in NativeFlow)
  const nativeFlowParams = (() => {
    try {
      const paramsStr =
        interactiveResponse?.nativeFlowResponseMessage?.paramsJson;
      if (paramsStr) return JSON.parse(paramsStr);
    } catch {}
    return null;
  })();
  // Template button reply (legacy, non-NativeFlow)
  const tmplResponse = msg?.message?.templateButtonReplyMessage;

  const selectedId =
    buttonsResponse?.selectedButtonId ||
    listResponse?.singleSelectReply?.selectedRowId ||
    nativeFlowParams?.id ||
    tmplResponse?.selectedId;

  if (!selectedId) return false;

  // Quiz buttons (qz: prefix) — let them fall through to LLM as plain text
  if (selectedId.startsWith("qz:")) return false;

  // Slash command buttons (/command)
  if (selectedId.startsWith("/")) {
    const { handleCommandListener } = await import("./commands/CommandRegistry.ts");
    const slashCommand = parseSlashCommand(selectedId);
    if (slashCommand) {
      const fakeMsg = {
        key: { ...msg.key, id: `btn_${Date.now()}` },
        message: { conversation: selectedId },
        pushName: msg.pushName,
      };
      const context = {
        slashCommand, chatId,
        chatType: isGroup ? "group" : "private",
        senderId, senderIsAdmin, senderIsOwner,
        senderDisplay: msg.pushName || "",
        botIsAdmin: group?.botIsAdmin || false,
        botIsSuperAdmin: group?.botIsSuperAdmin || false,
        contextMsgId: null, text: selectedId, group, msg: fakeMsg,
      };
      await handleCommandListener(fakeMsg, context);
    }
    return true;
  }

  // model_select: prefix — change per-chat model
  if (selectedId.startsWith("model_select:")) {
    const modelId = selectedId.replace("model_select:", "");
    // permission check: owner or group admin (unless activation gate)
    setLlm2Model(chatId, modelId);
    // Node is the WS SERVER: emit reliable control events to this account's
    // Python client via the account registry (src/server/accountRegistry.ts).
    account.sendReliableToClient({ type: "set_llm2_model", chatId, modelId });
    account.sendReliableToClient({ type: "invalidate_llm2_model", chatId });
    await sock.sendMessage(chatId, {
      text: `Model diubah ke: ${displayName}${visionNote}`,
    });
    return true;
  }

  // settings: prefix — show settings sub-menus
  if (selectedId.startsWith("settings:")) {
    const action = selectedId.replace("settings:", "");
    if (action === "model") { /* show model list via sendNativeFlow */ }
    if (action === "prompt") { /* show /prompt help */ }
    if (action === "permission") { /* show /permission help */ }
    return true;
  }

  // modelcfg: / modelcfg_ prefix — owner-only model management
  if (selectedId.startsWith("modelcfg:") || selectedId.startsWith("modelcfg_")) {
    if (!isOwnerJid(senderId)) { /* reject */ return true; }
    // Handles: list, add, edit, default <modelId>, remove <modelId>
    return true;
  }

  return false;
}
```

See `src/wa/connection.ts` for the complete implementation with permission checks, activation gate, owner validation, and WS state sync.

## Quiz System

WhatsApp quiz dikirim menggunakan `send_quiz` action dari Python bridge. Quiz menggunakan tombol NativeFlow `quick_reply` dengan ID berformat `qz:<label>`.

```javascript
// Di src/index.ts — mapping pilihan quiz ke tombol
const quizButtons = choices.map(ch => ({
  name: 'quick_reply',
  buttonParamsJson: JSON.stringify({
    display_text: ch.label,
    id: `qz:${ch.label}`
  })
}));
```

Saat pengguna mengetuk tombol quiz, response tiba sebagai NativeFlow `quick_reply` — nilai `id` (berprefiks `qz:`) diekstrak dari `interactiveResponseMessage.nativeFlowResponseMessage.paramsJson` di `src/wa/connection.ts`. Karena prefix `qz:`, handler mengembalikan `false` dan message diteruskan ke Python sebagai teks biasa — bukan sebagai command.

Lihat juga: `src/wa/inbound.ts` dan `src/wa/domain/caches.ts` (quizMessageIds untuk tracking).

## Common Mistakes

### ❌ WRONG: Using `rowId` instead of `id`
```javascript
// WRONG
rows: [{ rowId: '/prompt', title: 'Get Prompt' }]

// CORRECT
rows: [{ id: '/prompt', title: 'Get Prompt' }]
```

### ❌ WRONG: Mixing button types incorrectly
WhatsApp NativeFlow:
- All buttons in a message are sent together
- Each button is independent
- `quick_reply` buttons send text immediately
- `single_select` opens a dropdown first

### ❌ WRONG: Not handling the response
Button clicks need to be caught in `messages.upsert` and processed.

## Full Example: Settings Menu

```javascript
async function handleSettings({ chatId, chatType, senderIsAdmin, senderIsOwner }) {
  const buttons = [
    // quick_reply - sends command directly
    {
      name: 'quick_reply',
      buttonParamsJson: JSON.stringify({
        display_text: 'Get Prompt',
        id: '/prompt'
      })
    },
    // single_select - dropdown for model selection
    {
      name: 'single_select',
      buttonParamsJson: JSON.stringify({
        title: 'Change Model',
        sections: [{
          title: 'Select Model',
          rows: [
            { id: 'model_select:gpt-4o', title: 'GPT-4o' },
            { id: 'model_select:gpt-4o-mini', title: 'GPT-4o Mini' }
          ]
        }]
      })
    },
    // single_select - dropdown for permission
    {
      name: 'single_select',
      buttonParamsJson: JSON.stringify({
        title: 'Set Permission',
        sections: [{
          title: 'Permission Level',
          rows: [
            { id: '/permission 0', title: 'Forbidden' },
            { id: '/permission 1', title: 'Delete only' },
            { id: '/permission 2', title: 'Delete & mute' },
            { id: '/permission 3', title: 'All moderation' }
          ]
        }]
      })
    }
  ];

  await sendNativeFlow(
    sock, 
    chatId, 
    'Chat Settings\n\nSelect an option:', 
    buttons, 
    { footer: 'Click a button' }
  );
}
```

## Carousel (Eksperimental)

`sendCarousel` mengirim swipeable cards. **Status: error 479 saat pengiriman — belum resolved.**

```javascript
await sendCarousel(sock, chatId, [
  {
    image: { url: 'https://example.com/img.jpg' },
    title: 'Kartu 1',
    body: 'Deskripsi kartu 1',
    footer: 'Footer',
    buttons: [{ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Pilih', id: 'c1' }) }],
  },
], { title: 'Produk Unggulan' });
```

Implementasi: `src/wa/interactive/sendCarousel.ts`. Error 479 berarti struktur binary stanza tidak valid di server WhatsApp.

## LLM Reply Integration

Semua teks reply LLM dikirim melalui `sendRichMessage` dengan footer AI (`'Pesan ini dibuat oleh AI'`). Jika `sendRichMessage` gagal, fallback otomatis ke `sock.sendMessage`.

Dapat dikonfigurasi di `src/wa/outbound.ts`:
- **`LLM_REPLY_INTERACTIVE=true`** (env var) — menggunakan `sendRichMessage` (NativeFlow, tampilan kartu dengan footer)
- **`LLM_REPLY_INTERACTIVE=false`** — menggunakan `sock.sendMessage` biasa (teks polos, kompatibel dengan WA Web)

```javascript
// Di src/wa/outbound.ts
if (config.llmReplyInteractive) {
  try {
    sentMsg = await sendRichMessage(sock, chatId, {
      text: renderedText.text,
      footer: config.llmReplyFooter || undefined,
      quoted: quoted || undefined,
      mentions: renderedText.mentions,
      nonJidMentions: renderedText.nonJidMentions,
      adminGroupMention: renderedText.adminGroupMention || null,
    });
  } catch (err) {
    logger.warn({ err, chatId }, 'sendRichMessage failed, falling back to sendMessage');
    const textPayload = { text: renderedText.text };
    if (renderedText.mentions.length > 0) textPayload.mentions = renderedText.mentions;
    if (renderedText.nonJidMentions > 0) {
      textPayload.contextInfo = { ...textPayload.contextInfo, nonJidMentions: renderedText.nonJidMentions };
    }
    if (renderedText.adminGroupMention) {
      textPayload.contextInfo = { ...textPayload.contextInfo, groupMentions: [renderedText.adminGroupMention] };
    }
    sentMsg = await sock.sendMessage(chatId, textPayload, quoted ? { quoted } : {});
  }
}
```

Lihat `src/wa/interactive/README.md` untuk detail implementasi `sendRichMessage` dan binary nodes.

## Testing Buttons

Add debug logging to see button responses:

```javascript
logger.info({
  msgKey: msg?.key?.id,
  msgType: msg?.message ? Object.keys(msg.message).join(',') : 'none',
  hasButtons: !!buttonsResponse,
  hasList: !!listResponse,
  hasInteractive: !!interactiveResponse,
  selectedButtonId: buttonsResponse?.selectedButtonId,
  hasTemplateButton: !!tmplResponse,
  nativeFlowParams: interactiveResponse?.nativeFlowResponseMessage?.paramsJson,
  selectedRowId: listResponse?.singleSelectReply?.selectedRowId
}, 'button response received');
```

Gunakan `/debug` command untuk menguji semua tipe interactive message. Lihat `src/wa/interactive/README.md` untuk daftar lengkap perintah debug.
