/**
 * /remove-sticker <name> — Remove a sticker from the bot's catalog for this chat.
 *
 * Usage:
 *   `/remove-sticker <name>`
 *
 * Permissions:
 *   - Group : group admin or bot owner only
 *   - Private: anyone
 *
 * Optional flag:
 *   `/remove-sticker global <name>` — remove from the global catalog (owner only)
 */

import path from 'path';
import fs from 'fs-extra';
import Database from 'better-sqlite3';
import logger from '../../logger.js';
import config from '../../config.js';
import type { CommandContext, CommandHandler } from '../command/CommandContext.js';

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
    await reply('Only the bot owner can remove global stickers. ❌');
    return;
  }

  // ------------------------------------------------------------------
  // 3. Parse & validate sticker name
  // ------------------------------------------------------------------
  const rawName = nameArg.toLowerCase().trim();
  if (!rawName) {
    await reply(
      'Usage: `/remove-sticker <name>`\n\n'
      + 'The name must be lowercase letters, digits, underscore or minus (max 64 characters).\n'
      + 'Example: `/remove-sticker smile`\n\n'
      + '_Owner only:_ `/remove-sticker global <name>` — remove from the global catalog.',
    );
    return;
  }

  if (!STICKER_NAME_RE.test(rawName)) {
    await reply(
      `Invalid sticker name: *${rawName}*\n`
      + 'Use lowercase letters, digits, underscore (_) or minus (-), 1–64 characters.',
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
    await reply(`Failed to remove sticker: ${err.message} ❌`);
    return;
  }

  if (!deleted) {
    await reply(`Sticker${globalLabel} *${rawName}* not found. ❌`);
    return;
  }

  logger.info(
    { chatId, targetChatId, name: rawName, isGlobal },
    'remove-sticker: sticker removed',
  );

  await reply(`Sticker${globalLabel} *${rawName}* removed successfully. ✅`);
}

export { handleRemoveSticker };

export const removeStickerCommand: CommandHandler = {
  commands: ["remove-sticker", "remove-stickers", "removesticker", "removestickers"],
  description: "Remove a sticker from the bot's catalog by its name. Use /remove-sticker global <name> to remove it from the global catalog (owner only). Example: /remove-sticker funny cat.",
  permission: "isPrivate or isAdmin or isOwner",
  run: (_sock, _message, ctx) => handleRemoveSticker(ctx),
};