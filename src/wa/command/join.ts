import logger from "../../logger.js";
import type { CommandContext, CommandHandler } from '../commands/CommandContext.js';

// ---------------------------------------------------------------------------
// /join command — join a group via invite link
// ---------------------------------------------------------------------------

const INVITE_LINK_RE = /chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/;

/**
 * Extract a stable, lower-cased error token from a Baileys/Boom error.
 *
 * Baileys surfaces group-invite failures in a few different shapes:
 *   - a Boom error with `err.data` / `err.output.payload.message` set to a
 *     WhatsApp stanza error string (e.g. `"not-authorized"`, `"gone"`),
 *   - an HTTP-ish `err.output.statusCode` (e.g. 401, 404, 409, 429),
 *   - or just a plain `err.message` containing the token.
 * We normalise all of these into one lower-cased haystack for matching.
 */
function errorToken(err: any): { text: string; status: number | null } {
  const parts: string[] = [];
  if (err?.message) parts.push(String(err.message));
  if (err?.data) parts.push(String(err.data));
  const payloadMsg = err?.output?.payload?.message ?? err?.output?.payload?.error;
  if (payloadMsg) parts.push(String(payloadMsg));
  const status =
    typeof err?.output?.statusCode === "number"
      ? err.output.statusCode
      : typeof err?.status === "number"
        ? err.status
        : null;
  return { text: parts.join(" ").toLowerCase(), status };
}

/**
 * Map a /join failure to a friendly Indonesian message. Falls back to a
 * generic message (without leaking the raw error) for unknown failures.
 */
function joinErrorMessage(err: any): string {
  const { text, status } = errorToken(err);

  const has = (...tokens: string[]) => tokens.some((t) => text.includes(t));

  if (has("not-authorized", "not authorized", "forbidden") || status === 401 || status === 403) {
    return "Gagal masuk grup: bot tidak diizinkan masuk lewat link ini (kemungkinan bot pernah dikeluarkan). Minta admin grup menambahkan bot secara manual.";
  }
  if (has("gone", "item-not-found", "not-found", "not found") || status === 404) {
    return "Gagal masuk grup: link tidak valid atau sudah direset. Pastikan link benar atau minta link undangan yang baru.";
  }
  if (has("conflict", "already") || status === 409) {
    return "Gagal masuk grup: bot sudah berada di grup ini.";
  }
  if (has("rate-overlimit", "rate overlimit", "too many", "rate-limit", "rate limit") || status === 429) {
    return "Gagal masuk grup: terlalu banyak permintaan. Coba lagi beberapa saat lagi.";
  }
  if (has("timed out", "timeout")) {
    return "Gagal masuk grup: waktu permintaan habis. Periksa koneksi lalu coba lagi.";
  }
  if (has("full", "participant-limit", "size")) {
    return "Gagal masuk grup: grup sudah penuh.";
  }
  return "Gagal masuk grup. Pastikan link undangan masih valid dan coba lagi. Jika tetap gagal, minta admin grup menambahkan bot secara manual.";
}

async function handleJoinCommand({ chatId, senderId, args, sock }: CommandContext): Promise<void> {
  const input = (args || "").trim();
  if (!input) {
    try {
      await sock.sendMessage(chatId, {
        text: "Penggunaan: `/join` <link undangan atau kode>\nContoh: `/join` https://chat.whatsapp.com/ABC123",
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
      ? `Berhasil masuk grup. Group ID: ${groupId}`
      : "Berhasil masuk grup.";
    await sock.sendMessage(chatId, { text: reply });
    logger.info({ chatId, senderId, inviteCode, groupId }, "/join success");
  } catch (err: any) {
    logger.error({ err, inviteCode, chatId }, "/join failed");
    try {
      await sock.sendMessage(chatId, { text: joinErrorMessage(err) });
    } catch (e) {
      /* ignore */
    }
  }
}

export { handleJoinCommand, joinErrorMessage };

export const joinCommand: CommandHandler = { name: "join", aliases: ["joins"], run: handleJoinCommand };
