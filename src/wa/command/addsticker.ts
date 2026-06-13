/**
 * /addsticker <nama> — Tambahkan sticker ke katalog bot untuk chat ini.
 *
 * Cara pakai:
 *   - Kirim sticker WhatsApp dengan caption  `/addsticker <nama>`
 *   - Atau reply ke sticker yang sudah ada dengan  `/addsticker <nama>`
 *
 * Izin:
 *   - Group : hanya admin grup atau bot owner
 *   - Private: siapa saja (pengecualian — private chat = owner langsung)
 *
 * Nama sticker:
 *   - Huruf kecil, angka, underscore (_), tanda minus (-), panjang 1–64 karakter
 *   - Contoh: "smile", "thumbs_up", "no-way"
 *
 * Stiker yang ditambahkan disimpan di DB terpisah (stickers.db) dan tersedia
 * HANYA untuk chat yang menambahkannya (isolasi per-chat).
 *
 * Lottie/premium stickers:
 *   Untuk sticker premium WhatsApp (lottieStickerMessage, mime: application/was),
 *   alih-alih mendownload dan menyimpan file .webp (yang kehilangan animasi),
 *   kita simpan payload JSON asli dari lottieStickerMessage. Saat bot mengirim
 *   kembali sticker ini, payload tersebut direlay verbatim via Baileys relayMessage
 *   sehingga animasi Lottie tetap terjaga.
 */

import path from 'path';
import fs from 'fs-extra';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import logger from '../../logger.js';
import { unwrapMessage } from '../domain/messageParser.js';
import { downloadMediaToFile } from '../../mediaHandler.js';
import config from '../../config.js';
import { withTimeout } from '../utils.js';
import type { CommandContext, CommandHandler } from '../commands/CommandContext.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STICKER_NAME_RE = /^[a-z0-9_\-]{1,64}$/;

// Must match GLOBAL_STICKER_CHAT_ID in Python's sticker_db.py
const GLOBAL_STICKER_CHAT_ID = '__global__';

// DB path mirrors what Python's sticker_db.py resolves to
const STICKERS_DB_PATH = config.stickersDbPath;

// Directory where uploaded sticker files are stored persistently
const STICKER_UPLOAD_DIR = config.stickerUploadDir;

// ---------------------------------------------------------------------------
// DB helpers (lazy-open, WAL mode)
// ---------------------------------------------------------------------------

let _db: any = null;

function getDb(): any {
  if (_db) return _db;
  fs.ensureDirSync(path.dirname(STICKERS_DB_PATH));
  _db = new Database(STICKERS_DB_PATH, { timeout: 30000 });
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = FULL');
  _db.pragma('busy_timeout = 30000');
  _db.pragma('foreign_keys = ON');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS stickers (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id        TEXT    NOT NULL,
      name           TEXT    NOT NULL,
      file_path      TEXT    NOT NULL DEFAULT '',
      lottie_payload TEXT    DEFAULT NULL,
      added_by       TEXT    NOT NULL DEFAULT '',
      added_at       TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(chat_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_stickers_chat
      ON stickers (chat_id, name);
  `);
  // Migration: add lottie_payload column for existing installs
  try {
    _db.exec(`ALTER TABLE stickers ADD COLUMN lottie_payload TEXT DEFAULT NULL`);
  } catch { /* column already exists */ }
  return _db;
}

// ---------------------------------------------------------------------------
// Sticker type detection
// ---------------------------------------------------------------------------

/**
 * Returns true if the inner message object is a Lottie/premium sticker.
 * Lottie stickers are wrapped as lottieStickerMessage, or their inner
 * stickerMessage has isLottie=true or mimetype="application/was".
 */
function isLottieSticker(msgObj: any): boolean {
  if (!msgObj) return false;
  if (msgObj.lottieStickerMessage) return true;
  const sc = msgObj.stickerMessage;
  if (sc && (sc.isLottie === true || sc.mimetype === 'application/was')) return true;
  return false;
}

/**
 * Serialise the Lottie sticker payload to JSON for storage.
 * We store the lottieStickerMessage wrapper object (or a synthesised one
 * if the sticker arrived as a plain stickerMessage with isLottie=true).
 */
function serializeLottiePayload(msgObj: any, stickerContent: any): string {
  if (msgObj?.lottieStickerMessage) {
    // Preferred: store the full lottieStickerMessage wrapper as-is.
    // When relaying we wrap it back in { lottieStickerMessage: ... }.
    return JSON.stringify(msgObj.lottieStickerMessage);
  }
  // Fallback: wrap the stickerMessage inside a synthetic lottieStickerMessage.
  return JSON.stringify({ message: { stickerMessage: stickerContent } });
}

// ---------------------------------------------------------------------------
// Sticker file helpers (for regular / animated WebP stickers)
// ---------------------------------------------------------------------------

/**
 * Download the sticker from a WhatsApp message to a temp file.
 * Returns the temp file path, or null on failure.
 */
async function downloadStickerToTemp(stickerContent: any, messageId: string, mediaDir: string = config.mediaDir): Promise<string | null> {
  if (!stickerContent) return null;
  try {
    await fs.ensureDir(mediaDir);
    const tempPath = path.join(mediaDir, `addsticker_tmp_${messageId}.webp`);

    try {
      await downloadMediaToFile(stickerContent, 'sticker', tempPath, withTimeout);
    } catch (firstErr: any) {
      const msg = String(firstErr?.message || '').toLowerCase();
      const isDecryptError = msg.includes('bad decrypt')
        || msg.includes('unable to authenticate')
        || msg.includes('wrong final block')
        || msg.includes('mac check failed')
        || msg.includes('failed to decrypt');
      if (!isDecryptError) throw firstErr;
      logger.warn({ err: firstErr, messageId }, 'addsticker: sticker decrypt failed, retrying as image');
      await fs.remove(tempPath).catch(() => {});
      await downloadMediaToFile(stickerContent, 'image', tempPath, withTimeout);
    }

    return tempPath;
  } catch (err) {
    logger.warn({ err, messageId }, 'addsticker: failed to download sticker media');
    return null;
  }
}

/**
 * Persist the sticker file to the upload directory.
 * Returns the persistent path.
 */
async function persistStickerFile(tempPath: string, chatId: string, name: string, uploadDir: string = STICKER_UPLOAD_DIR): Promise<string> {
  await fs.ensureDir(uploadDir);
  const { createHash } = await import('crypto');
  const chatHash = createHash('md5').update(chatId).digest('hex').slice(0, 8);
  const destFilename = `${chatHash}_${name}.webp`;
  const destPath = path.join(uploadDir, destFilename);
  await fs.copy(tempPath, destPath, { overwrite: true });
  return destPath;
}

// ---------------------------------------------------------------------------
// DB write helpers
// ---------------------------------------------------------------------------

/** Register a regular (WebP) sticker. */
function upsertWebpSticker(chatId: string, name: string, filePath: string, addedBy: string): string {
  const db = getDb();
  const existing = db.prepare(
    'SELECT id FROM stickers WHERE chat_id = ? AND name = ?',
  ).get(chatId, name);

  if (existing) {
    db.prepare(
      `UPDATE stickers
       SET file_path = ?, lottie_payload = NULL, added_by = ?, added_at = datetime('now')
       WHERE chat_id = ? AND name = ?`,
    ).run(filePath, addedBy, chatId, name);
    return 'updated';
  }
  db.prepare(
    `INSERT INTO stickers (chat_id, name, file_path, lottie_payload, added_by)
     VALUES (?, ?, ?, NULL, ?)`,
  ).run(chatId, name, filePath, addedBy);
  return 'added';
}

/** Register a Lottie sticker using its JSON payload (no file). */
function upsertLottieSticker(chatId: string, name: string, lottiePayloadJson: string, addedBy: string): string {
  const db = getDb();
  const existing = db.prepare(
    'SELECT id FROM stickers WHERE chat_id = ? AND name = ?',
  ).get(chatId, name);

  if (existing) {
    db.prepare(
      `UPDATE stickers
       SET file_path = '', lottie_payload = ?, added_by = ?, added_at = datetime('now')
       WHERE chat_id = ? AND name = ?`,
    ).run(lottiePayloadJson, addedBy, chatId, name);
    return 'updated';
  }
  db.prepare(
    `INSERT INTO stickers (chat_id, name, file_path, lottie_payload, added_by)
     VALUES (?, ?, '', ?, ?)`,
  ).run(chatId, name, lottiePayloadJson, addedBy);
  return 'added';
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

async function handleAddSticker({
  chatId,
  chatType,
  senderIsAdmin,
  senderIsOwner,
  senderId,
  args,
  msg,
  sock,
  account,
}: CommandContext): Promise<void> {

  // Per-tenant media / sticker-upload dirs (CONTRACT.md §8): the staged temp
  // file and the persisted catalog sticker must live under THIS account's
  // folder so the outbound allowlist (now tenant-scoped) accepts the path the
  // LLM later references via send_sticker.
  const mediaDir = account?.mediaDir ?? config.mediaDir;
  const uploadDir = account?.stickerUploadDir ?? config.stickerUploadDir;

  async function reply(text: string): Promise<void> {
    try {
      await sock.sendMessage(chatId, { text });
    } catch (err) {
      logger.warn({ err, chatId }, 'addsticker: failed to send reply');
    }
  }

  // ------------------------------------------------------------------
  // 1. Parse global flag
  // ------------------------------------------------------------------
  const rawArgs = (args || '').trim();
  const parts = rawArgs.split(/\s+/);
  const isGlobal = parts[0]?.toLowerCase() === 'global';
  const nameArg = isGlobal ? parts.slice(1).join(' ').trim() : rawArgs;
  const targetChatId = isGlobal ? GLOBAL_STICKER_CHAT_ID : chatId;

  // ------------------------------------------------------------------
  // 2. Permission check
  // ------------------------------------------------------------------
  if (isGlobal && !senderIsOwner) {
    await reply('Hanya bot owner yang bisa menambahkan sticker global. ❌');
    return;
  }

  const isPrivate = chatType === 'private';
  if (!isGlobal && !isPrivate && !senderIsAdmin && !senderIsOwner) {
    await reply('Hanya admin grup yang bisa menambahkan sticker. ❌');
    return;
  }

  // ------------------------------------------------------------------
  // 3. Parse & validate sticker name
  // ------------------------------------------------------------------
  const rawName = nameArg.toLowerCase();
  if (!rawName) {
    await reply(
      'Cara pakai: `/add-sticker <nama>`\n'
      + 'Kirim/reply sticker dengan caption tersebut.\n\n'
      + 'Nama harus huruf kecil, angka, underscore atau minus (maks 64 karakter).\n'
      + 'Contoh: `/add-sticker senyum`\n\n'
      + '_Owner only:_ `/add-sticker global <nama>` — tambahkan ke katalog global (semua chat).',
    );
    return;
  }

  if (!STICKER_NAME_RE.test(rawName)) {
    await reply(
      `Nama sticker tidak valid: *${rawName}*\n`
      + 'Gunakan huruf kecil, angka, underscore (_) atau tanda minus (-), 1–64 karakter.',
    );
    return;
  }

  // ------------------------------------------------------------------
  // 4. Find sticker in message or quoted message
  //
  //    WhatsApp sticker formats:
  //    a) Regular / animated WebP:  message.stickerMessage
  //    b) Premium Lottie sticker :  message.lottieStickerMessage.message.stickerMessage
  //       (outer wrapper has mimetype "application/was")
  //
  //    For Lottie: we store the payload JSON, NOT a downloaded file.
  //    For regular: we download and store the .webp file.
  // ------------------------------------------------------------------
  const { message: innerMessage } = unwrapMessage(msg!.message) || {};
  let stickerContent: any = null;       // the stickerMessage proto object
  let sourceMsgObj: any = null;         // the raw message object containing the sticker
  let messageIdForFile: string = msg!.key?.id || randomUUID();

  /**
   * Extract the stickerMessage content + the source msgObj from any wrapper.
   */
  function extractSticker(msgObj: any): { content: any; msgObj: any } | null {
    if (!msgObj) return null;
    if (msgObj.stickerMessage) return { content: msgObj.stickerMessage, msgObj };
    const lottie = msgObj.lottieStickerMessage;
    if (lottie?.message?.stickerMessage) {
      return { content: lottie.message.stickerMessage, msgObj };
    }
    return null;
  }

  // Current message
  if (innerMessage) {
    const extracted = extractSticker(innerMessage);
    if (extracted) {
      stickerContent = extracted.content;
      sourceMsgObj = extracted.msgObj;
    }
  }

  // Quoted message fallback
  if (!stickerContent) {
    const ctx = (innerMessage as any)?.extendedTextMessage?.contextInfo
      || (innerMessage as any)?.stickerMessage?.contextInfo
      || (innerMessage as any)?.lottieStickerMessage?.message?.stickerMessage?.contextInfo
      || null;
    if (ctx?.quotedMessage) {
      const { message: qMsg } = unwrapMessage(ctx.quotedMessage) || {};
      const extracted = extractSticker(qMsg || ctx.quotedMessage);
      if (extracted) {
        stickerContent = extracted.content;
        sourceMsgObj = extracted.msgObj;
        messageIdForFile = ctx.stanzaId || messageIdForFile;
      }
    }
  }

  if (!stickerContent) {
    await reply(
      'Tidak ada sticker yang ditemukan.\n'
      + 'Kirim sticker dengan caption `/addsticker <nama>`, atau reply ke sticker dengan perintah tersebut.',
    );
    return;
  }

  // ------------------------------------------------------------------
  // 5. Save — Lottie: store JSON payload; regular: download file
  // ------------------------------------------------------------------
  const lottie = isLottieSticker(sourceMsgObj);
  const globalLabel = isGlobal ? ' global' : '';

  if (lottie) {
    // --- Lottie path: serialise payload JSON, no file download ---
    try {
      const lottiePayloadJson = serializeLottiePayload(sourceMsgObj, stickerContent);
      const action = upsertLottieSticker(targetChatId, rawName, lottiePayloadJson, senderId || '');

      logger.info(
        { chatId, targetChatId, name: rawName, senderId, action, type: 'lottie', isGlobal },
        'addsticker: lottie sticker registered (payload saved, no file download)',
      );

      if (action === 'updated') {
        await reply(`Sticker Lottie${globalLabel} *${rawName}* berhasil diperbarui! ✨✅`);
      } else {
        await reply(
          `Sticker Lottie${globalLabel} *${rawName}* berhasil ditambahkan! ✨✅\n`
          + 'Bot bisa menggunakan sticker animasi ini sepenuhnya.',
        );
      }
    } catch (err: any) {
      logger.error({ err, chatId, name: rawName }, 'addsticker: lottie save failed');
      await reply(`Gagal menyimpan sticker Lottie: ${err.message} ❌`);
    }
    return;
  }

  // --- Regular / animated WebP path: download file ---
  let tempPath: string | null = null;
  try {
    tempPath = await downloadStickerToTemp(stickerContent, messageIdForFile, mediaDir);
    if (!tempPath) {
      await reply('Gagal mengunduh sticker. Coba lagi nanti. ❌');
      return;
    }

    const destPath = await persistStickerFile(tempPath, targetChatId, rawName, uploadDir);
    const action = upsertWebpSticker(targetChatId, rawName, destPath, senderId || '');

    logger.info(
      { chatId, targetChatId, name: rawName, senderId, action, type: 'webp', isGlobal },
      'addsticker: webp sticker registered',
    );

    if (action === 'updated') {
      await reply(`Sticker${globalLabel} *${rawName}* berhasil diperbarui! ✅`);
    } else {
      await reply(`Sticker${globalLabel} *${rawName}* berhasil ditambahkan! ✅\nBot sekarang bisa menggunakan sticker ini.`);
    }
  } catch (err: any) {
    logger.error({ err, chatId, name: rawName }, 'addsticker: failed');
    await reply(`Gagal menyimpan sticker: ${err.message} ❌`);
  } finally {
    if (tempPath) {
      try { await fs.remove(tempPath); } catch { /* ignore */ }
    }
  }
}

export { handleAddSticker };

export const addStickerCommand: CommandHandler = { name: "add-sticker", aliases: ["addsticker", "addstickers", "add-stickers"], run: handleAddSticker };