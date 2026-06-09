import logger from "../../logger.js";
import { isOwnerJid } from "../../participants.js";
import { messageCache } from "../../caches.js";
import { getSock } from "../connection.js";
import { sendRichMessage } from "../interactive/index.js";
import { getAnnouncementEnabled } from "../../db.js";
import { withJidQueue } from "../sendQueue.js";

async function reconstructAndSend(sock, targetJid, cachedMsg) {
  const msg = cachedMsg.message;
  if (!msg) {
    logger.warn(
      { targetJid },
      "reconstructAndSend: cachedMsg.message is empty",
    );
    return { ok: false, reason: "error" };
  }

  try {
    const { generateWAMessageFromContent, generateMessageIDV2 } =
      await import("baileys");
    const wrappedMsg = generateWAMessageFromContent(targetJid, msg, {
      userJid: sock.user.id,
    });
    await withJidQueue(targetJid, () =>
      sock.relayMessage(targetJid, wrappedMsg.message, {
        messageId: wrappedMsg.key.id,
      }),
    );
    return { ok: true };
  } catch (err) {
    logger.warn(
      { err, targetJid },
      "reconstructAndSend: failed to send message",
    );
    return { ok: false, reason: "error" };
  }
}

async function fetchGroupJids(sock, chatId) {
  let groupJids = [];
  try {
    const groups = await sock.groupFetchAllParticipating();
    groupJids = Object.keys(groups || {});
  } catch (err) {
    logger.error({ err }, "failed fetching groups for broadcast");
    try {
      await sock.sendMessage(chatId, { text: "Failed to fetch group list." });
    } catch (e) {
      logger.warn({ e }, "failed sending group fetch error");
    }
    return null;
  }

  if (groupJids.length === 0) {
    try {
      await sock.sendMessage(chatId, { text: "Bot is not in any groups." });
    } catch (e) {
      logger.warn({ e }, "failed sending no-groups message");
    }
    return null;
  }

  return groupJids;
}

async function handleBroadcastCommand({
  chatId,
  senderId,
  text,
  quotedMessageId,
  contextMsgId,
  msg,
}) {
  const sock = getSock();
  if (!isOwnerJid(senderId)) {
    logger.info({ senderId, chatId }, "/broadcast rejected: not owner");
    try {
      await sock.sendMessage(chatId, {
        text: "Only bot owners can use `/broadcast`.",
      });
    } catch (err) {
      logger.warn({ err }, "failed sending broadcast rejection");
    }
    return;
  }

  const trimmedText = text && text.trim();
  const firstWord = trimmedText
    ? trimmedText.split(/\s+/)[0].toLowerCase()
    : "";
  const isDebug = firstWord === "debug";
  const isTextBroadcast = trimmedText && !isDebug;

  if (isTextBroadcast) {
    // Text broadcast: /broadcast <text>
    const groupJids = await fetchGroupJids(sock, chatId);
    if (!groupJids) return;

    let sent = 0;
    let failed = 0;
    let skipped = 0;
    for (const groupJid of groupJids) {
      if (!getAnnouncementEnabled(groupJid)) {
        skipped += 1;
        continue;
      }
      try {
        await withJidQueue(groupJid, () =>
          sendRichMessage(sock, groupJid, {
            text: trimmedText,
            footer: "Broadcast 📢",
            badge: false,
          }),
        );
        sent += 1;
      } catch (err) {
        logger.warn({ err, groupJid }, "broadcast send failed");
        failed += 1;
      }
    }

    try {
      const summary = `Broadcast complete: ${sent} group${sent !== 1 ? "s" : ""} sent${failed > 0 ? `, ${failed} failed` : ""}${skipped > 0 ? `, ${skipped} skipped (opted out)` : ""}.`;
      await sock.sendMessage(chatId, { text: summary });
    } catch (err) {
      logger.warn({ err }, "failed sending broadcast confirmation");
    }

    logger.info(
      { sent, failed, skipped, total: groupJids.length, chatId, senderId },
      "broadcast completed",
    );
  } else if (isDebug && !quotedMessageId) {
    // Debug mode invoked without a quoted message
    try {
      await sock.sendMessage(chatId, {
        text: "Reply to a message to use `/broadcast debug`.",
      });
    } catch (e) {
      logger.warn({ e }, "failed sending debug no-reply error");
    }
  } else if (quotedMessageId) {
    // Reply broadcast: /broadcast (replying to a message), with optional 'debug' flag
    const cachedMsg = messageCache.get(quotedMessageId);
    if (!cachedMsg) {
      try {
        await sock.sendMessage(chatId, {
          text: "Replied message not found in cache. Try replying to a more recent message.",
        });
      } catch (e) {
        logger.warn({ e }, "failed sending cache-miss error");
      }
      return;
    }

    if (isDebug) {
      // Debug mode: send only to this chat
      const debugResult = await reconstructAndSend(sock, chatId, cachedMsg);
      try {
        if (debugResult.ok) {
          await sock.sendMessage(chatId, {
            text: "Debug broadcast: message sent to this chat only.",
          });
        } else {
          await sock.sendMessage(chatId, {
            text: `Debug broadcast failed: ${debugResult.reason || "unknown error"}.`,
          });
        }
      } catch (err) {
        logger.warn({ err }, "failed sending debug broadcast confirmation");
      }
      return;
    }

    // Full broadcast to all groups
    const groupJids = await fetchGroupJids(sock, chatId);
    if (!groupJids) return;

    let sent = 0;
    let failed = 0;
    let skipped = 0;
    for (const groupJid of groupJids) {
      if (!getAnnouncementEnabled(groupJid)) {
        skipped += 1;
        continue;
      }
      const result = await reconstructAndSend(sock, groupJid, cachedMsg);
      if (result.ok) {
        sent += 1;
      } else {
        failed += 1;
      }
    }

    try {
      const summary = `Broadcast complete: ${sent} group${sent !== 1 ? "s" : ""} sent${failed > 0 ? `, ${failed} failed` : ""}${skipped > 0 ? `, ${skipped} skipped (opted out)` : ""}.`;
      await sock.sendMessage(chatId, { text: summary });
    } catch (err) {
      logger.warn({ err }, "failed sending broadcast confirmation");
    }

    logger.info(
      { sent, failed, skipped, total: groupJids.length, chatId, senderId },
      "broadcast completed",
    );
  } else {
    try {
      await sock.sendMessage(chatId, {
        text: "Usage: `/broadcast <text>`, or reply to a message with `/broadcast` (broadcasts to all groups) or `/broadcast debug` (sends only to this chat).",
      });
    } catch (e) {
      logger.warn({ e }, "failed sending usage message");
    }
    return;
  }
}

export { handleBroadcastCommand, reconstructAndSend };
