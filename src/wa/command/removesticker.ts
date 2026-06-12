/**
 * /remove-sticker <nama> — Hapus sticker dari katalog bot untuk chat ini.
 *
 * Cara pakai:
 *   `/remove-sticker <nama>`
 *
 * Izin:
 *   - Group : hanya admin grup atau bot owner
 *   - Private: siapa saja
 *
 * Flag opsional:
 *   `/remove-sticker global <nama>` — hapus dari katalog global (owner only)
 */

import path from 'path';
import fs from 'fs-extra';
import Database from 'better-sqlite3';
import logger from '../../logger.js';
import config from '../../config.js';
import type { CommandContext, CommandHandler } from '../commands/CommandContext.js';

// ---------------------------------------------------------------------------
// Constants (must mirror addsticker.js and sticker_db.py)
// ---------------------------------------------------------------------------

const STICKER_NAME_RE = /^[a-z0-9_\-]{1,64}$/;
const GLOBAL_STICKER_CHAT_ID = '__global__';

const STICKERS_DB_PATH = config.stickersDbPath;

// ---------------------------------------------------------------------------
// DB helper (lazy-open, shared WAL config)
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
  return _db;
}

// ---------------------------------------------------------------------------
// DB write helper
// ---------------------------------------------------------------------------

/**
 * Delete a sticker row. Returns true if a row was deleted.
 */
function deleteSticker(chatId: string, name: string): boolean {
  const db = getDb();
  const result = db.prepare(
    'DELETE FROM stickers WHERE chat_id = ? AND name = ?',
  ).run(chatId, name);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

async function handleRemoveSticker({
  chatId,
  chatType,
  senderIsAdmin,
  senderIsOwner,
  args,
  sock,
}: CommandContext): Promise<void> {

  async function reply(text: string): Promise<void> {
    try {
      await sock.sendMessage(chatId, { text });
    } catch (err) {
      logger.warn({ err, chatId }, 'remove-sticker: failed to send reply');
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
    await reply('Hanya bot owner yang bisa menghapus sticker global. ❌');
    return;
  }

  const isPrivate = chatType === 'private';
  if (!isGlobal && !isPrivate && !senderIsAdmin && !senderIsOwner) {
    await reply('Hanya admin grup yang bisa menghapus sticker. ❌');
    return;
  }

  // ------------------------------------------------------------------
  // 3. Parse & validate sticker name
  // ------------------------------------------------------------------
  const rawName = nameArg.toLowerCase().trim();
  if (!rawName) {
    await reply(
      'Cara pakai: `/remove-sticker <nama>`\n\n'
      + 'Nama harus huruf kecil, angka, underscore atau minus (maks 64 karakter).\n'
      + 'Contoh: `/remove-sticker senyum`\n\n'
      + '_Owner only:_ `/remove-sticker global <nama>` — hapus dari katalog global.',
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
  // 4. Delete from DB
  // ------------------------------------------------------------------
  const globalLabel = isGlobal ? ' global' : '';
  let deleted = false;

  try {
    deleted = deleteSticker(targetChatId, rawName);
  } catch (err: any) {
    logger.error({ err, chatId, targetChatId, name: rawName }, 'remove-sticker: db delete failed');
    await reply(`Gagal menghapus sticker: ${err.message} ❌`);
    return;
  }

  if (!deleted) {
    await reply(`Sticker${globalLabel} *${rawName}* tidak ditemukan. ❌`);
    return;
  }

  logger.info(
    { chatId, targetChatId, name: rawName, isGlobal },
    'remove-sticker: sticker removed',
  );

  await reply(`Sticker${globalLabel} *${rawName}* berhasil dihapus. ✅`);
}

export { handleRemoveSticker };

export const removeStickerCommand: CommandHandler = { name: "remove-sticker", aliases: ["remove-stickers", "removesticker", "removestickers"], run: handleRemoveSticker };