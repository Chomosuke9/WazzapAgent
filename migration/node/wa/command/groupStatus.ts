import path from "path";
import fs from "fs-extra";
import {
  generateWAMessageContent,
  generateMessageIDV2,
} from "baileys";
import logger from "../../logger.js";
import { unwrapMessage } from "../../messageParser.js";
import { downloadMediaToFile, mapMediaKind } from "../../mediaHandler.js";
import config from "../../config.js";
import { withTimeout } from "../utils.js";
import { findRawMediaContent } from "./groupStatusHelpers.js";
import type { CommandContext } from "./parseCommand.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip device ID from a JID to get the canonical form.
 * e.g. "62812xxx:5@s.whatsapp.net" -> "62812xxx@s.whatsapp.net"
 */
function getCleanJid(jid: string): string {
  return jid.split(":")[0].split("/")[0] + "@s.whatsapp.net";
}

/**
 * Build the contextInfo required for group status messages.
 * - isGroupStatus: true  — marks this as a group status
 * - statusAttributions  — carries the type + authorJid so WhatsApp shows attribution
 */
function createGroupStatusContextInfo(authorJid: string) {
  return {
    isGroupStatus: true,
    statusAttributions: [
      {
        type: 5, // StatusAttributionType.GROUP_STATUS
        groupStatus: { authorJid: getCleanJid(authorJid) },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Media download helper
// ---------------------------------------------------------------------------

async function downloadMediaContent(
  content: any,
  contentType: string | null | undefined,
  messageId: string | null | undefined,
): Promise<{ filepath: string; mediaKind: string } | null> {
  const mediaKind = mapMediaKind(contentType);
  if (!mediaKind || !["image", "video"].includes(mediaKind)) return null;

  try {
    const extMap: Record<string, string> = { image: "jpg", video: "mp4" };
    const ext = extMap[mediaKind] || "bin";
    const filename = `${messageId}_groupStatus.${ext}`;
    const filepath = path.join(config.mediaDir, filename);
    await downloadMediaToFile(content, mediaKind as 'image' | 'video', filepath, withTimeout);
    return { filepath, mediaKind };
  } catch (err) {
    logger.warn(
      { err, messageId, contentType },
      "failed to download media for group-status",
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Send helper — unified group status via groupStatusMessageV2
// ---------------------------------------------------------------------------

/**
 * Send a group status message (text, image, or video) to a group.
 *
 * Matches the gifted-baileys gcstatus.js reference implementation:
 *   1. generateWAMessageContent — uploads media (if any) and builds the proto.
 *      It auto-sets messageContextInfo.messageSecret internally via
 *      shouldIncludeReportingToken — do NOT override it.
 *   2. Inject contextInfo attribution only for extendedTextMessage (text).
 *      Media messages must NOT have contextInfo per the reference payload.
 *   3. Wrap in groupStatusMessageV2 and relay.
 *      No manual messageSecret, no additionalAttributes overrides.
 *      Baileys' getMediaType is patched (patches/baileys+7.0.0-rc11.patch)
 *      to detect inner media inside groupStatusMessageV2, so mediatype is
 *      set automatically on the stanza.
 */
async function sendGroupStatus(
  sock: any,
  jid: string,
  content: any,
  authorJid: string,
): Promise<any> {
  // Step 1 — upload media (if any) and build the proto message.
  // generateWAMessageContent auto-sets messageContextInfo.messageSecret
  // via shouldIncludeReportingToken — do NOT override it.
  const waMsgContent = await generateWAMessageContent(content, {
    upload: sock.waUploadToServer,
  });

  const innerMsg: any = (waMsgContent as any).message || waMsgContent;

  // Step 2 — inject contextInfo attribution only for text (extendedTextMessage).
  // Media messages must NOT have contextInfo per the reference payload.
  const contextInfo = createGroupStatusContextInfo(authorJid);
  for (const key of Object.keys(innerMsg)) {
    if (key === "extendedTextMessage") {
      innerMsg[key].contextInfo = contextInfo;
    }
  }

  // Step 3 — wrap in groupStatusMessageV2 and relay.
  // No manual messageSecret.
  // Baileys' getMediaType is patched (patches/baileys+7.0.0-rc11.patch) to detect
  // inner media inside groupStatusMessageV2, so the stanza mediatype attribute is
  // set automatically — no additionalAttributes override needed.
  const wrappedMessage = {
    groupStatusMessageV2: {
      message: innerMsg,
    },
  };

  const messageId = generateMessageIDV2(sock.user?.id);

  // gifted-baileys getMediaType now handles groupStatusMessageV2 inner media detection
  // via the patch in patches/baileys+7.0.0-rc11.patch — no need to override additionalAttributes.
  await sock.relayMessage(jid, wrappedMessage, { messageId });

  return {
    key: { remoteJid: jid, fromMe: true, id: messageId },
    message: wrappedMessage,
  };
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

async function handleGroupStatus({
  chatId,
  chatType,
  senderIsAdmin,
  senderIsOwner,
  senderId,
  args,
  msg,
  fromMe,
  sock,
}: CommandContext): Promise<void> {

  // Only works in groups
  if (chatType !== "group") {
    try {
      await sock.sendMessage(chatId, {
        text: "This command can only be used in a group.",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  // Permission: admin, owner, or the bot itself (fromMe)
  if (!senderIsAdmin && !senderIsOwner && !fromMe) {
    logger.info({ chatId }, "/group-status rejected: not admin, owner, or bot");
    try {
      await sock.sendMessage(chatId, {
        text: "Only admin/owner can send group status.",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  const caption = (args || "").trim();
  const authorJid = sock.user?.id || senderId;
  const { message: innerMessage } = unwrapMessage(msg!.message) || {};
  let mediaResult: { filepath: string; mediaKind: string } | null = null;

  // Mode 1: Media attached directly to this message.
  // We must check the RAW message (msg.message) directly — normalizeMessageContent
  // can convert an imageMessage/videoMessage with a caption that looks like a command
  // into an extendedTextMessage, hiding the actual media type from contentType.
  const rawMsg = msg!.message;
  const rawMediaFound = findRawMediaContent(rawMsg);
  const directMediaContent = rawMediaFound?.content || null;
  const directMediaType = rawMediaFound?.contentType || null;

  if (directMediaType && directMediaContent) {
    mediaResult = await downloadMediaContent(
      directMediaContent,
      directMediaType,
      msg!.key.id,
    );
  }

  // Mode 2: Reply to a media message
  // contextInfo can live inside extendedTextMessage (text reply) or inside the
  // media message itself (image/video reply with caption).
  if (!mediaResult) {
    const contextInfo: any =
      innerMessage?.extendedTextMessage?.contextInfo ||
      (directMediaType && directMediaContent?.contextInfo) ||
      null;
    if (contextInfo?.quotedMessage) {
      const ctx = contextInfo;
      const { contentType: qType, message: qMsg } =
        unwrapMessage(ctx.quotedMessage) || {};
      if (
        (qType === "imageMessage" || qType === "videoMessage") &&
        qMsg?.[qType]
      ) {
        mediaResult = await downloadMediaContent(
          qMsg![qType],
          qType,
          ctx.stanzaId,
        );
      }
    }
  }

  try {
    if (mediaResult) {
      const content = {
        [mediaResult.mediaKind]: { url: mediaResult.filepath },
        caption: caption || "",
      };
      await sendGroupStatus(sock, chatId, content, authorJid);
      logger.info(
        { chatId, mediaKind: mediaResult.mediaKind, hasCaption: !!caption },
        "group-status sent with media",
      );
    } else if (caption) {
      await sendGroupStatus(sock, chatId, { text: caption }, authorJid);
      logger.info({ chatId }, "group-status sent as text");
    } else {
      try {
        await sock.sendMessage(chatId, {
          text: "Reply to an image/video or provide text.",
        });
      } catch (err) {
        /* ignore */
      }
      return;
    }
  } catch (err: any) {
    logger.error({ err, chatId }, "failed to send group-status");
    try {
      await sock.sendMessage(chatId, {
        text: `Failed to send group status: ${err.message}`,
      });
    } catch (e) {
      /* ignore */
    }
  } finally {
    if (mediaResult?.filepath) {
      try {
        await fs.remove(mediaResult.filepath);
      } catch {
        /* ignore */
      }
    }
  }
}

export { handleGroupStatus, sendGroupStatus };
