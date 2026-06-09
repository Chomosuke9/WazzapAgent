import logger from "../../logger.js";
import { getSock } from "../connection.js";

// ---------------------------------------------------------------------------
// /join command — join a group via invite link
// ---------------------------------------------------------------------------

const INVITE_LINK_RE = /chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/;

async function handleJoinCommand({ chatId, senderId, args }) {
  const sock = getSock();
  const input = (args || "").trim();
  if (!input) {
    try {
      await sock.sendMessage(chatId, {
        text: "Usage: `/join` <invite link or code>\nExample: `/join` https://chat.whatsapp.com/ABC123",
      });
    } catch (e) {
      /* ignore */
    }
    return;
  }

  // Extract invite code from link or use raw code
  const linkMatch = input.match(INVITE_LINK_RE);
  const inviteCode = linkMatch ? linkMatch[1] : input;

  try {
    const groupId = await sock.groupAcceptInvite(inviteCode);
    const reply = groupId
      ? `Joined group successfully. Group ID: ${groupId}`
      : "Joined group successfully.";
    await sock.sendMessage(chatId, { text: reply });
    logger.info({ chatId, senderId, inviteCode, groupId }, "/join success");
  } catch (err) {
    logger.error({ err, inviteCode, chatId }, "/join failed");
    try {
      await sock.sendMessage(chatId, {
        text: `Failed to join group: ${err?.message || err}\n\n*Error list:*\n- \`not-authorized\`: Bot habis di kick jadi tidak bisa masuk lewat link, harus di tambahkan manual oleh admin.\n- \`gone\`: Group tidak di temukan, biasanya antara link-nya salah atau di reset.\n- \`conflict\`: Bot sudah ada di group ini, silakan gunakan link yang berbeda.`,
      });
    } catch (e) {
      /* ignore */
    }
  }
}

export { handleJoinCommand };
