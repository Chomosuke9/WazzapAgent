# Interactive Messages — Implementation Notes

> **Baca ini dulu sebelum menyentuh file apapun di folder ini.**
> Dokumen ini merangkum semua hal penting yang ditemukan saat mengimplementasikan
> pesan interaktif WhatsApp di Baileys v7. Banyak hal di sini **tidak terdokumentasi**
> secara resmi dan hanya ditemukan melalui riset dan trial-error.

---

## Daftar File

| File | Isi |
|------|-----|
| `sendInteractive.js` | Core helper + NativeFlow functions (quick reply, URL, copy, call, list, combined, rich) |
| `sendButtons.js` | Legacy button formats (ButtonsMessage, TemplateMessage) |
| `sendCarousel.js` | Carousel / swipeable cards |
| `index.js` | Barrel re-export semua fungsi publik |

---

## Bagaimana Cara Kerjanya (Wajib Dibaca)

### 1. Jangan pakai `sock.sendMessage` untuk `interactiveMessage`

`sock.sendMessage` melewati `prepareWAMessageMedia` yang tidak mendukung `interactiveMessage`
dan akan throw `"Invalid media type"`. Semua interactive message **harus** menggunakan:

```js
import { generateWAMessageFromContent, proto } from 'baileys';

const msg = generateWAMessageFromContent(jid, { /* content */ }, { userJid: sock.user.id });
await sock.relayMessage(jid, msg.message, { messageId: msg.key.id, additionalNodes: [...] });
```

### 2. Wrapper proto yang benar

Semua `interactiveMessage` harus dibungkus dalam:

```js
{
  viewOnceMessage: {
    message: {
      messageContextInfo: {
        deviceListMetadata: {},
        deviceListMetadataVersion: 2,
      },
      interactiveMessage: proto.Message.InteractiveMessage.create({ ... }),
    },
  },
}
```

**Jangan** langsung taruh `interactiveMessage` di level atas — tidak akan dirender.

### 3. `proto.create()`, bukan `.fromObject()`

Baileys v7 **menghapus** `.fromObject()` dari tipe `InteractiveMessage` dan subtipe-nya.
Untuk `InteractiveMessage` dan turunannya, selalu gunakan `.create()`. Catatan: `ButtonsMessage`
dan `TemplateMessage` (di `sendButtons.js`) **masih** menggunakan `.fromObject()` dan tetap
berfungsi.

```js
// ✅ Benar (InteractiveMessage)
proto.Message.InteractiveMessage.create({ ... })
proto.Message.InteractiveMessage.Header.create({ ... })
proto.Message.InteractiveMessage.Body.create({ text: '...' })
proto.Message.InteractiveMessage.NativeFlowMessage.create({ buttons: [...] })

// ❌ Salah — akan throw di Baileys v7
proto.Message.InteractiveMessage.fromObject({ ... })

// ✅ Masih valid (ButtonsMessage / TemplateMessage — legacy)
proto.Message.ButtonsMessage.fromObject({ ... })
proto.Message.TemplateMessage.fromObject({ ... })
```

### 4. Binary nodes (`additionalNodes`) — WAJIB

Tanpa `additionalNodes` yang benar, WhatsApp akan menampilkan:
> *"Anda telah menerima pesan, tetapi versi WhatsApp anda tidak mendukungnya."*

Struktur yang benar (berlaku untuk **semua** tipe interactive message termasuk carousel):

```js
function buildInteractiveNodes(jid, badge = true) {
  const nodes = [
    {
      tag: 'biz',
      attrs: {},
      content: [
        {
          tag: 'interactive',
          attrs: { type: 'native_flow', v: '1' },   // SELALU native_flow
          content: [
            { tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }, // child WAJIB ada
          ],
        },
      ],
    },
  ];
  if (badge && !isJidGroup(jid)) {
    nodes.push({ tag: 'bot', attrs: { biz_bot: '1' } }); // badge AI — private chat only
  }
  return nodes;
}
```

**Hal-hal penting:**
- `type` di `interactive` attrs selalu `'native_flow'` — bahkan untuk carousel
- Child node `native_flow` dengan `v: '9'` dan `name: 'mixed'` **harus ada** di dalam `interactive`
- Node `bot` (`biz_bot: '1'`) hanya untuk private chat (bukan `@g.us`) — ini yang menciptakan badge AI
- Carousel sempat dicoba dengan `type: 'carousel'` → **error 479**, tidak bekerja

### 5. Error codes yang relevan

| Error | Artinya |
|-------|---------|
| `"Invalid media type"` | Pakai `sock.sendMessage` untuk `interactiveMessage` — ganti ke `relayMessage` |
| Pesan "versi tidak didukung" | `additionalNodes` salah/tidak ada |
| Error 479 (ACK) | Struktur binary stanza tidak valid di server — paling sering: tipe node salah, atau field proto hilang |

---

## Fungsi-Fungsi yang Tersedia

### `sendRichMessage(sock, jid, options)` — Fungsi Utama / Universal

Kirim pesan styled dengan footer, header opsional, dan tombol opsional.
Ini adalah fungsi paling fleksibel — gunakan ini sebagai default untuk pesan bot.

```js
// Pesan teks biasa dengan footer AI
await sendRichMessage(sock, jid, {
  text: 'Halo!',
  footer: 'Pesan ini dibuat oleh AI',
});

// Dengan header (title) dan tombol
await sendRichMessage(sock, jid, {
  title: 'Konfirmasi',
  text: 'Lanjutkan pesanan?',
  footer: 'Tap tombol di bawah',
  buttons: [
    { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Ya', id: 'yes' }) },
    { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Tidak', id: 'no' }) },
  ],
});

// Dengan image header
await sendRichMessage(sock, jid, {
  image: { url: 'https://example.com/img.jpg' },
  title: 'Produk A',
  text: 'Deskripsi produk',
  footer: 'Rp 100.000',
});

// Tanpa badge AI (misalnya untuk broadcast)
await sendRichMessage(sock, jid, { text: 'Halo', footer: 'Broadcast 📢', badge: false });

// Dengan @mentions
await sendRichMessage(sock, jid, {
  text: 'Halo @628123456789!',
  footer: 'Bot',
  mentions: ['628123456789@s.whatsapp.net'],
});
```

**Catatan tentang `title` tanpa media:**
`Header.title` di proto mungkin tidak dirender secara visual oleh WhatsApp jika tidak ada
image/video. Jika ingin header yang pasti terlihat tanpa media, pertimbangkan
untuk memasukkan teks judul langsung ke `text` dengan formatting (`*bold*`).

**`subtitle`:** `sendRichMessage` mendukung `options.subtitle` (`sendInteractive.js:341`)
yang akan muncul di bawah `title` di header. Kombinasi `title` + `subtitle` memberi efek
judul dan deskripsi singkat tanpa perlu media.

### `sendQuickReply(sock, jid, body, buttons, options)`

```js
await sendQuickReply(sock, jid, 'Pilih menu:', [
  { id: 'menu_1', displayText: 'Produk' },
  { id: 'menu_2', displayText: 'Hubungi CS' },
], { title: 'Menu', footer: 'Bot v1' });
```

### `sendUrlButtons(sock, jid, body, buttons, options)`

```js
await sendUrlButtons(sock, jid, 'Kunjungi kami:', [
  { displayText: 'Website', url: 'https://example.com' },
]);
```

**Catatan:** `sendUrlButtons` **tidak** meneruskan `options.mentions` ke `_sendInteractive`.
Mention tidak didukung untuk tipe tombol URL.

### `sendCopyCode(sock, jid, body, copyCode, displayText, options)`

```js
await sendCopyCode(sock, jid, 'Kode promo:', 'PROMO2024', 'Salin Kode');
```

### `sendCombinedButtons(sock, jid, body, buttons, options)`

Campurkan berbagai tipe tombol dalam satu pesan:

**Catatan:** `sendCombinedButtons` **tidak** meneruskan `options.mentions` ke `_sendInteractive`.
Untuk mention di pesan dengan tombol, gunakan `sendRichMessage` atau `sendQuickReply`.

```js
await sendCombinedButtons(sock, jid, 'Pilih aksi:', [
  { type: 'reply', displayText: 'Konfirmasi', id: 'confirm' },
  { type: 'url',   displayText: 'Detail', url: 'https://example.com' },
  { type: 'copy',  displayText: 'Salin', copyCode: 'CODE123' },
  { type: 'call',  displayText: 'Telepon', phoneNumber: '+6281234567890' },
]);
```

### `sendNativeFlow(sock, jid, body, buttons, options)`

Raw NativeFlow — untuk tombol tipe lain (`single_select`, dll.) dengan format pre-built:

```js
await sendNativeFlow(sock, jid, 'Pilih opsi:', [
  {
    name: 'single_select',
    buttonParamsJson: JSON.stringify({
      title: 'Pilih',
      sections: [{ title: 'Kategori', rows: [{ title: 'Item', id: 'item1' }] }],
    }),
  },
]);
```

### `sendList(sock, jid, content, options)`

List/dropdown menggunakan `listMessage` via `sock.sendMessage` biasa (bukan interactive):

```js
await sendList(sock, jid, {
  title: 'Menu',
  buttonText: 'Buka Daftar',
  description: 'Tap untuk melihat pilihan',
  footer: 'Pilih satu item',
  sections: [{
    title: 'Kategori',
    rows: [{ rowId: 'item1', title: 'Item 1', description: 'Deskripsi' }],
  }],
});
```

**Catatan tentang `selectedRowId`:** Lokasi `selectedRowId` berbeda tergantung bagaimana
user memilih item:

| Skenario | Path `selectedRowId` |
|----------|----------------------|
| User pakai **list** (`listResponseMessage`) | `msg.message.listResponseMessage.singleSelectReply.selectedRowId` |
| User pakai **interactive** (`interactiveResponseMessage`) — terjadi di beberapa versi WA Mobile | `msg.message.interactiveResponseMessage.singleSelectReply.selectedRowId` |

Kode parsing harus mengecek **kedua** lokasi:

```js
// src/messageParser.js — pola yang benar
const selectedRowId =
  listResponse?.singleSelectReply?.selectedRowId ||
  interactiveResponse?.singleSelectReply?.selectedRowId;
```

Fallback ke `interactiveResponseMessage` penting karena WhatsApp Mobile terkadang
mengirim response sebagai `interactiveResponseMessage` meskipun message aslinya adalah
`listMessage`. Ini adalah inkonsistensi dari pihak WhatsApp, bukan bug kode.

### `sendCarousel(sock, jid, cards, options)` — ⚠️ Eksperimental

Carousel / swipeable cards. **Status: error 479 saat pengiriman, belum resolved.**

```js
await sendCarousel(sock, jid, [
  {
    image: { url: 'https://example.com/img.jpg' },
    title: 'Kartu 1',
    body: 'Deskripsi kartu 1',
    footer: 'Footer',
    buttons: [{ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Pilih', id: 'c1' }) }],
  },
], { title: 'Produk Unggulan', text: 'Swipe untuk lihat lebih' });
```

**Investigasi error 479 (sejauh ini):**

| Pendekatan | Hasil |
|------------|-------|
 | `type: 'carousel'` di node `interactive` attrs | ❌ Error 479 — server tolak |
 | Tetap pakai `type: 'native_flow'` dengan `carouselMessage` di proto | ❌ Error 479 — tetap gagal |
 | Hanya 1 card (bukan multiple) | ❌ Error 479 |
 | Tanpa image header di cards (body-only) | ❌ Error 479 |
 | `messageVersion: 1` vs `messageVersion: 2` | ❌ Error 479 |
 | Tanpa buttons di cards | ❌ Error 479 |

**Kesimpulan sementara:** Error 479 kemungkinan berasal dari:
1. **Server-side restrictions** — WhatsApp mungkin membatasi carousel hanya untuk business API resmi, bukan di web gateway
2. **Binary stanza structure** — Mungkin ada field atau node tambahan yang diperlukan server tapi tidak didokumentasikan
3. **Proto version mismatch** — `CarouselMessage` mungkin butuh versi proto lebih baru dari yang didukung Baileys v7

**Workaround:** Untuk menampilkan beberapa opsi, gunakan `sendRichMessage` dengan tombol terpisah
atau `sendList` dengan sections. Carousel tidak bisa digunakan di production sampai ada
perubahan dari WhatsApp atau Baileys.

---

## Mentions di Interactive Message

Mentions bekerja melalui `contextInfo.mentionedJid` di proto `InteractiveMessage`.
`_sendInteractive` menerima parameter `mentions` (array JID) dan menyuntikkannya:

```js
// Internal — di _sendInteractive:
const ctxFields = {};
if (mentions.length > 0) ctxFields.mentionedJid = mentions;
if (nonJidMentions > 0) ctxFields.nonJidMentions = nonJidMentions;
if (Object.keys(ctxFields).length > 0) {
  interactiveContent.contextInfo = proto.ContextInfo.create(ctxFields);
}
```

`sendRichMessage` meneruskan `options.mentions` dan `options.nonJidMentions` ke sini secara otomatis.

### `adminGroupMention` hanya berfungsi di plain-text fallback

`sendRichMessage` menerima `options.adminGroupMention` (`outbound.js:366`) tapi `_sendInteractive`
**tidak menanganinya**. Fitur @admin (groupMentions) hanya berfungsi di jalur plain-text fallback
(`outbound.js:376`) saat `sendRichMessage` gagal. Dalam mode interactive, @admin tetap tampil
sebagai teks biasa tanpa tag ke admin grup.

---

## Badge AI

Badge AI (label "AI" di pojok pesan) muncul dari node `{ tag: 'bot', attrs: { biz_bot: '1' } }`
di `additionalNodes`. **Hanya bekerja di private chat (`@s.whatsapp.net` / `@lid`).**
Di group chat, node ini diabaikan — tidak ada badge.

Untuk mematikan badge: `badge: false` di `sendRichMessage`, atau gunakan `buildInteractiveNodes(jid, false)`.

---

## Integrasi dengan LLM Replies (`outbound.js`)

### Kontrol dengan `LLM_REPLY_INTERACTIVE`

Env var `LLM_REPLY_INTERACTIVE` (default `false`) menentukan format reply LLM:

| Value | Perilaku | Kelebihan | Kekurangan |
|-------|----------|-----------|------------|
| `false` (default) | `sock.sendMessage` biasa (plain text) | Bekerja di **semua** klien termasuk WA Web | Tampilan polos, tanpa footer interaktif |
| `true` | `sendRichMessage` (interactive card) | Footer terpisah, tampilan lebih modern di mobile | **Tidak muncul** di WA Web (viewOnceMessage wrapper) |

### Footer dengan `LLM_REPLY_FOOTER`

Env var `LLM_REPLY_FOOTER` mengontrol teks footer yang ditambahkan ke setiap reply:

- **Mode interactive** (`LLM_REPLY_INTERACTIVE=true`): Footer dikirim sebagai `footer` di `sendRichMessage` — muncul sebagai teks abu-abu di bawah pesan.
- **Mode plain** (`LLM_REPLY_INTERACTIVE=false`): Footer digabung ke body text dengan separator `\n\n` — karena `sock.sendMessage` tidak punya field footer terpisah.

Jika `LLM_REPLY_FOOTER` kosong, tidak ada footer yang ditambahkan.

### Implementasi di `outbound.js`

```js
// Di src/wa/outbound.js — sendOutgoing()
if (config.llmReplyInteractive) {
  // Interactive mode: sendRichMessage dengan optional footer
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
    // Fallback — pesan tetap terkirim
    logger.warn({ err, chatId }, 'sendRichMessage failed, falling back to sendMessage');
    sentMsg = await sock.sendMessage(chatId, textPayload, quoted ? { quoted } : {});
  }
} else {
  // Plain mode: sock.sendMessage — footer digabung ke body
  const bodyText = config.llmReplyFooter
    ? `${renderedText.text}\n\n${config.llmReplyFooter}`
    : renderedText.text;
  sentMsg = await sock.sendMessage(chatId, { text: bodyText, ... }, quoted ? { quoted } : {});
}
```

### Fallback mechanism

Jika `sendRichMessage` throw error (misalnya socket disconnected, timeout, atau error proto),
system otomatis fallback ke `sock.sendMessage` biasa. Ini memastikan pesan **tetap terkirim**
meskipun format interaktif gagal. Logger mencatat warning dengan `chatId` dan `err` untuk debugging.

### Copy code button untuk code blocks

Fitur terpisah namun terkait: ketika LLM reply mengandung code block, Python bridge mengirim
action `send_copy_code` ke Node. Implementasi ada di `src/index.js:314-348` — Node menerima
action tersebut, membuat quoted preview sintetis dengan dummy ID (`CPY_...`), lalu memanggil
`sendCopyCode` dengan `quotedPreviewText` berupa potongan code yang akan disalin.
Reply button ini menggunakan `relayMessage` dengan `viewOnceMessage` wrapper yang sama.
Deteksi code block terjadi di Python bridge, **bukan** di Node. Tidak ada penambahan
copy code button otomatis di `outbound.js`.

---

## Integrasi Quiz (`send_quiz` action)

Quiz dikirim dari Python bridge sebagai action `send_quiz` dan diproses di `src/index.js`.

### Alur pengiriman

1. **Python** (LLM2) memanggil tool `send_quiz` → action `send_quiz` dikirim via WS
2. **Node** (`src/index.js:209`) menerima action, memanggil `sendQuickReply` dengan button ID ber-`qz:` prefix
3. **WhatsApp** menampilkan quick reply buttons — user tap salah satu
4. **Node** (`src/wa/connection.js:424`) mendeteksi `selectedId` berawalan `qz:` → **tidak** ditangani lokal, diteruskan ke Python
5. **Python** menerima reply sebagai `incoming_message` biasa → LLM2 mengevaluasi jawaban

### Button ID format: `qz:<label>`

Semua quiz buttons menggunakan prefix `qz:` untuk membedakannya dari button jenis lain:

```js
// src/index.js — mapping dari pilihan LLM ke button
const buttons = choices.map((ch) => ({
  id: `qz:${ch.label}`,      // prefix qz: — critical untuk routing
  displayText: ch.text,       // teks yang muncul di button
}));
```

Tanpa prefix `qz:`, quiz reply akan ditangani oleh handler button lokal Node (sama seperti
button `/setting` atau `modelcfg:`) dan tidak akan sampai ke LLM.

### Quiz message tracking (`quizMessageIds`)

Setiap quiz yang dikirim dicatat message ID-nya di `quizMessageIds` Set (bounded 2000 entries):

```js
// src/caches.js
const quizMessageIds = new Set();
const MAX_QUIZ_IDS = 2000;
```

Set ini digunakan di `src/wa/inbound.js` untuk membedakan:

- **Quiz reply**: user menjawab quiz → `isQuizButtonReply=true` atau `isQuizReply=true` → diteruskan ke LLM
- **Settings reply**: user tap button `/setting` → `replyToInteractive=true` → diset `contextOnly=true` (diblokir dari LLM)

```js
// src/wa/inbound.js:255-267
const isQuizButtonReply = Boolean(
  msg?.message?.templateButtonReplyMessage?.selectedId?.startsWith('qz:')
);
const isInteractiveReply = !isQuizButtonReply && repliedToBot && quoted?.type === 'interactiveMessage';
const isQuizReply = isInteractiveReply && Boolean(quoted?.messageId && quizMessageIds.has(quoted.messageId));
const replyToInteractive = isInteractiveReply && !isQuizReply; // → contextOnly=true
```

### Catatan penting

- `question` dikirim apa adanya (LLM sudah memasukkan pilihan ke dalam teks) — Node tidak auto-append daftar pilihan
- Mention resolution (`@Name (senderRef)`) tetap dilakukan di `question` text sebelum dikirim
- Quiz buttons adalah `quick_reply` NativeFlow — bukan `listMessage` atau `single_select`
- Action ack mengembalikan `{ contextMsgId, messageId }` untuk hydrasi history di Python

---

## Status Setiap Tipe Pesan

| Tipe | Status | Catatan |
|------|--------|---------|
| `sendQuickReply` | ✅ Bekerja | |
| `sendUrlButtons` | ✅ Bekerja | |
| `sendCopyCode` | ✅ Bekerja | |
| `sendCombinedButtons` | ✅ Bekerja | |
| `sendNativeFlow` | ✅ Bekerja | Base function untuk semua NativeFlow |
| `sendRichMessage` | ✅ Bekerja | `title` tanpa media mungkin tidak render |
| `sendList` | ✅ Bekerja | Pakai `sock.sendMessage`, bukan `relayMessage` |
| `sendCarousel` | ⚠️ Error 479 | Ditunda — belum ditemukan solusi |
| `sendLegacyButtons` | ❓ Tidak diuji | Format lama, kemungkinan deprecated |
| `sendTemplate` | ❓ Tidak diuji | Format lama, kemungkinan deprecated |

---

## `/debug` Command

Untuk menguji semua tipe di WhatsApp:

```
/debug buttons      → quick_reply, cta_url, cta_copy, cta_call
/debug menu         → single_select dropdown
/debug list         → sendList
/debug rich         → sendRichMessage (tanpa & dengan tombol)
/debug combined     → semua tipe tombol dalam satu pesan
/debug broadcast    → preview format pesan broadcast
/debug all          → semua 6 tipe di atas sekaligus
/debug carousel     → carousel (eksperimental, mungkin error)
/debug carousel-img → carousel dengan image header (eksperimental)
```

---

## Recent Changes

### Copy code button untuk code blocks (commit `4ffa2df`)
- LLM replies yang mengandung code block otomatis ditambahi CTA copy code button
- Menggunakan `sendCopyCode` dengan `quotedPreviewText` berisi potongan code
- Button di-reply ke pesan asli, bukan dikirim sebagai pesan terpisah

### Perbaikan quoted preview untuk CTA copy code (commit `5c9bbf1`, `c9dad3c`)
- CTA copy code button sebelumnya tidak memiliki quoted preview → button tidak muncul
- Solusi: dummy quoted preview message dikirim sebelum button, menggunakan `relayMessage`
- Commit `c9dad3c` mengganti quoted preview dengan `key: { fromMe: true, id: 'dummy_cta_copy' }` — ID dummy untuk menghindari lookup message yang tidak ada

### Penghapusan reply-to dan badge AI dari `sendCopyCode` (commit `8e0851a`)
- Copy code button dulunya di-reply ke pesan asli + badge AI
- Ternyata CTA copy tidak perlu badge AI (bukan konten AI, hanya utility button)
- Reply-to juga dihapus karena button CTA akan muncul di atas pesan asli tanpa perlu quote

### Integrasi quiz dengan `qz:` prefix (commit `8a4afa8`)
- Penambahan `quizMessageIds` Set di `caches.js` untuk tracking pesan quiz
- Perbaikan routing: plain-text reply ke quiz button sekarang benar sampai ke LLM
- Settings menu interactive reply tetap di-block (`contextOnly=true`) — tidak tercampur dengan quiz

### `LLM_REPLY_INTERACTIVE` dan `LLM_REPLY_FOOTER`
- Penambahan env var untuk mengontrol format reply LLM
- Footer dapat dikustomisasi tanpa mengubah kode
- Fallback mechanism: jika `sendRichMessage` gagal, auto-fallback ke `sock.sendMessage`
