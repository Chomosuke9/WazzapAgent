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

import logger from '../../logger.js';
import {
  STICKER_NAME_RE,
  parseStickerScope,
  deleteSticker,
} from './stickerStore.js';
import type { CommandContext, CommandHandler } from '../command/CommandContext.js';

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

async function handleRemoveSticker({
  chatId,
  senderIsOwner,
  args,
  sock,
  folderPath,
}: CommandContext): Promise<void> {

  async function reply(text: string): Promise<void> {
    try {
      await sock.sendMessage(chatId, { text });
    } catch (err) {
      logger.warn({ err, chatId }, 'remove-sticker: failed to send reply');
    }
  }

  // ------------------------------------------------------------------
  // 1. Parse scope (`global` | `default` → shared catalog; else per-chat)
  // ------------------------------------------------------------------
  const { isShared, targetChatId, name: nameArg, label: scopeLabel } =
    parseStickerScope(args, chatId);

  // ------------------------------------------------------------------
  // 2. Permission check
  // ------------------------------------------------------------------
  if (isShared && !senderIsOwner) {
    await reply('Only the bot owner can remove shared stickers. ❌');
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
      + '_Owner only:_ `/remove-sticker default <name>` (or `global`) — remove from the shared catalog.',
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
  let deleted = false;

  try {
    deleted = deleteSticker(folderPath, targetChatId, rawName);
  } catch (err: unknown) {
    logger.error({ err, chatId, targetChatId, name: rawName }, 'remove-sticker: db delete failed');
    await reply(`Failed to remove sticker: ${err instanceof Error ? err.message : String(err)} ❌`);
    return;
  }

  if (!deleted) {
    await reply(`Sticker${scopeLabel} *${rawName}* not found. ❌`);
    return;
  }

  logger.info(
    { chatId, targetChatId, name: rawName, isShared },
    'remove-sticker: sticker removed',
  );

  await reply(`Sticker${scopeLabel} *${rawName}* removed successfully. ✅`);
}

export { handleRemoveSticker };

export const removeStickerCommand: CommandHandler = {
  commands: ["remove-sticker", "remove-stickers", "removesticker", "removestickers"],
  description: "Remove a sticker from the bot's catalog by its name. Use /remove-sticker default <name> (or global) to remove it from the shared catalog (owner only). Example: /remove-sticker funny_cat.",
  permission: "isPrivate or isAdmin or isOwner",
  run: (_sock, _message, ctx) => handleRemoveSticker(ctx),
};