/**
 * /addsticker <name> — Add a sticker to the bot's catalog for this chat.
 *
 * Usage:
 *   - Send a WhatsApp sticker with the caption  `/addsticker <name>`
 *   - Or reply to an existing sticker with  `/addsticker <name>`
 *
 * Permissions:
 *   - Group : group admin or bot owner only
 *   - Private: anyone (exception — private chat = owner directly)
 *
 * Sticker name:
 *   - Lowercase letters, digits, underscore (_), minus (-), length 1–64 characters
 *   - Example: "smile", "thumbs_up", "no-way"
 *
 * Added stickers are stored in a separate DB (stickers.db) and are available
 * ONLY to the chat that added them (per-chat isolation).
 *
 * Lottie/premium stickers:
 *   For WhatsApp premium stickers (lottieStickerMessage, mime: application/was),
 *   instead of downloading and storing a .webp file (which loses the animation),
 *   we store the original JSON payload from lottieStickerMessage. When the bot
 *   sends this sticker back, that payload is relayed verbatim via Baileys
 *   relayMessage so the Lottie animation is preserved.
 */

import path from "path";
import fs from "fs-extra";
import { randomUUID } from "crypto";
import logger from "../../logger.js";
import { unwrapMessage } from "../domain/messageParser.js";
import { downloadMediaToFile } from "../../mediaHandler.js";
import config from "../../config.js";
import { withTimeout } from "../utils.js";
import type { proto, DownloadableMessage } from "baileys";
import {
  STICKER_NAME_RE,
  parseStickerScope,
  upsertWebpSticker,
  upsertLottieSticker,
} from "./stickerStore.js";
import type {
  CommandContext,
  CommandHandler,
} from "../command/CommandContext.js";

// ---------------------------------------------------------------------------
// Sticker type detection
// ---------------------------------------------------------------------------

/**
 * Returns true if the inner message object is a Lottie/premium sticker.
 * Lottie stickers are wrapped as lottieStickerMessage, or their inner
 * stickerMessage has isLottie=true or mimetype="application/was".
 */
function isLottieSticker(msgObj: proto.IMessage | null | undefined): boolean {
  if (!msgObj) return false;
  if (msgObj.lottieStickerMessage) return true;
  const sc = msgObj.stickerMessage;
  if (sc && (sc.isLottie === true || sc.mimetype === "application/was"))
    return true;
  return false;
}

/**
 * Serialise the Lottie sticker payload to JSON for storage.
 * We store the lottieStickerMessage wrapper object (or a synthesised one
 * if the sticker arrived as a plain stickerMessage with isLottie=true).
 */
function serializeLottiePayload(msgObj: proto.IMessage | null | undefined, stickerContent: proto.Message.IStickerMessage | null | undefined): string {
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
async function downloadStickerToTemp(
  stickerContent: DownloadableMessage,
  messageId: string,
  mediaDir: string = config.mediaDir,
): Promise<string | null> {
  if (!stickerContent) return null;
  try {
    await fs.ensureDir(mediaDir);
    const tempPath = path.join(mediaDir, `addsticker_tmp_${messageId}.webp`);

    try {
      await downloadMediaToFile(
        stickerContent,
        "sticker",
        tempPath,
        withTimeout,
      );
    } catch (firstErr: unknown) {
      const theErr = firstErr as Record<string, unknown> | null | undefined;
      const msg = String(theErr?.message || "").toLowerCase();
      const isDecryptError =
        msg.includes("bad decrypt") ||
        msg.includes("unable to authenticate") ||
        msg.includes("wrong final block") ||
        msg.includes("mac check failed") ||
        msg.includes("failed to decrypt");
      if (!isDecryptError) throw firstErr;
      logger.warn(
        { err: firstErr, messageId },
        "addsticker: sticker decrypt failed, retrying as image",
      );
      await fs.remove(tempPath).catch(() => {});
      await downloadMediaToFile(stickerContent, "image", tempPath, withTimeout);
    }

    return tempPath;
  } catch (err) {
    logger.warn(
      { err, messageId },
      "addsticker: failed to download sticker media",
    );
    return null;
  }
}

/**
 * Persist the sticker file to the upload directory.
 * Returns the persistent path.
 */
async function persistStickerFile(
  tempPath: string,
  chatId: string,
  name: string,
  uploadDir: string = config.stickerUploadDir,
): Promise<string> {
  await fs.ensureDir(uploadDir);
  const { createHash } = await import("crypto");
  const chatHash = createHash("md5").update(chatId).digest("hex").slice(0, 8);
  const destFilename = `${chatHash}_${name}.webp`;
  const destPath = path.join(uploadDir, destFilename);
  await fs.copy(tempPath, destPath, { overwrite: true });
  return destPath;
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

async function handleAddSticker({
  chatId,
  senderIsOwner,
  senderId,
  args,
  msg,
  sock,
  account,
  folderPath,
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
      logger.warn({ err, chatId }, "addsticker: failed to send reply");
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
    await reply("Only the bot owner can add shared stickers. ❌");
    return;
  }

  // ------------------------------------------------------------------
  // 3. Parse & validate sticker name
  // ------------------------------------------------------------------
  const rawName = nameArg.toLowerCase();
  if (!rawName) {
    await reply(
      "Usage: `/add-sticker <name>`\n" +
        "Send/reply to a sticker with that caption.\n\n" +
        "The name must be lowercase letters, digits, underscore or minus (max 64 characters).\n" +
        "Example: `/add-sticker smile`\n\n" +
        "_Owner only:_ `/add-sticker default <name>` (or `global`) — add to the shared catalog (all chats).",
    );
    return;
  }

  if (!STICKER_NAME_RE.test(rawName)) {
    await reply(
      `Invalid sticker name: *${rawName}*\n` +
        "Use lowercase letters, digits, underscore (_) or minus (-), 1–64 characters.",
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
  let stickerContent: proto.Message.IStickerMessage | null = null;
  let sourceMsgObj: proto.IMessage | null = null;
  let messageIdForFile: string = msg!.key?.id || randomUUID();

  /**
   * Extract the stickerMessage content + the source msgObj from any wrapper.
   */
  function extractSticker(msgObj: proto.IMessage | null | undefined): { content: proto.Message.IStickerMessage; msgObj: proto.IMessage } | null {
    if (!msgObj) return null;
    if (msgObj.stickerMessage)
      return { content: msgObj.stickerMessage, msgObj };
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
    const ctx =
      innerMessage?.extendedTextMessage?.contextInfo ||
      innerMessage?.stickerMessage?.contextInfo ||
      innerMessage?.lottieStickerMessage?.message?.stickerMessage
        ?.contextInfo ||
      null;
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
      "No sticker found.\n" +
        "Send a sticker with the caption `/addsticker <name>`, or reply to a sticker with that command.",
    );
    return;
  }

  // ------------------------------------------------------------------
  // 5. Save — Lottie: store JSON payload; regular: download file
  // ------------------------------------------------------------------
  const lottie = isLottieSticker(sourceMsgObj);

  if (lottie) {
    // --- Lottie path: serialise payload JSON, no file download ---
    try {
      const lottiePayloadJson = serializeLottiePayload(
        sourceMsgObj,
        stickerContent,
      );
      const action = upsertLottieSticker(
        folderPath,
        targetChatId,
        rawName,
        lottiePayloadJson,
        senderId || "",
      );

      logger.info(
        {
          chatId,
          targetChatId,
          name: rawName,
          senderId,
          action,
          type: "lottie",
          isShared,
        },
        "addsticker: lottie sticker registered (payload saved, no file download)",
      );

      if (action === "updated") {
        await reply(
          `Lottie sticker${scopeLabel} *${rawName}* updated successfully! ✨✅`,
        );
      } else {
        await reply(
          `Lottie sticker${scopeLabel} *${rawName}* added successfully! ✨✅\n` +
            "The bot can use this animated sticker fully.",
        );
      }
    } catch (err: unknown) {
      logger.error(
        { err, chatId, name: rawName },
        "addsticker: lottie save failed",
      );
      await reply(`Failed to save Lottie sticker: ${err instanceof Error ? err.message : String(err)} ❌`);
    }
    return;
  }

  // --- Regular / animated WebP path: download file ---
  let tempPath: string | null = null;
  try {
    tempPath = await downloadStickerToTemp(
      stickerContent,
      messageIdForFile,
      mediaDir,
    );
    if (!tempPath) {
      await reply("Failed to download the sticker. Try again later. ❌");
      return;
    }

    const destPath = await persistStickerFile(
      tempPath,
      targetChatId,
      rawName,
      uploadDir,
    );
    const action = upsertWebpSticker(
      folderPath,
      targetChatId,
      rawName,
      destPath,
      senderId || "",
    );

    logger.info(
      {
        chatId,
        targetChatId,
        name: rawName,
        senderId,
        action,
        type: "webp",
        isShared,
      },
      "addsticker: webp sticker registered",
    );

    if (action === "updated") {
      await reply(
        `Sticker${scopeLabel} *${rawName}* updated successfully! ✅`,
      );
    } else {
      await reply(
        `Sticker${scopeLabel} *${rawName}* added successfully! ✅\nThe bot can now use this sticker.`,
      );
    }
  } catch (err: unknown) {
    logger.error({ err, chatId, name: rawName }, "addsticker: failed");
    await reply(`Failed to save sticker: ${err instanceof Error ? err.message : String(err)} ❌`);
  } finally {
    if (tempPath) {
      try {
        await fs.remove(tempPath);
      } catch {
        /* ignore */
      }
    }
  }
}

export { handleAddSticker };

export const addStickerCommand: CommandHandler = {
  commands: ["add-sticker", "addsticker", "addstickers", "add-stickers"],
  description:
    "Add a sticker to the bot's catalog by replying to a sticker and naming it. The bot can send stickers from this catalog using the send_sticker tool. Use /add-sticker default <name> (or global) to add it to the shared catalog for all chats (owner only). Example: /add-sticker funny_cat.",
  permission: "isPrivate or isAdmin or isOwner",
  run: (_sock, _message, ctx) => handleAddSticker(ctx),
};
