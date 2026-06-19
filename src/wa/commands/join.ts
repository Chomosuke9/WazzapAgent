import logger from "../../logger.js";
import type {
  CommandContext,
  CommandHandler,
} from "../command/CommandContext.js";

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
  const payloadMsg =
    err?.output?.payload?.message ?? err?.output?.payload?.error;
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
 * Map a /join failure to a friendly English message. Falls back to a
 * generic message (without leaking the raw error) for unknown failures.
 */
function joinErrorMessage(err: any): string {
  const { text, status } = errorToken(err);

  const has = (...tokens: string[]) => tokens.some((t) => text.includes(t));

  if (
    has("not-authorized", "not authorized", "forbidden") ||
    status === 401 ||
    status === 403
  ) {
    return "Failed to join the group: the bot is not allowed in via this link (it may have been removed before). Ask a group admin to add the bot manually.";
  }
  if (
    has("gone", "item-not-found", "not-found", "not found") ||
    status === 404
  ) {
    return "Failed to join the group: the link is invalid or has been reset. Make sure the link is correct or ask for a new invite link.";
  }
  if (has("conflict", "already") || status === 409) {
    return "Failed to join the group: the bot is already in this group.";
  }
  if (
    has(
      "rate-overlimit",
      "rate overlimit",
      "too many",
      "rate-limit",
      "rate limit",
    ) ||
    status === 429
  ) {
    return "Failed to join the group: too many requests. Try again in a little while.";
  }
  if (has("timed out", "timeout")) {
    return "Failed to join the group: the request timed out. Check your connection and try again.";
  }
  if (has("full", "participant-limit", "size")) {
    return "Failed to join the group: the group is full.";
  }
  return "Failed to join the group. Make sure the invite link is still valid and try again. If it keeps failing, ask a group admin to add the bot manually.";
}

async function handleJoinCommand({
  chatId,
  senderId,
  args,
  sock,
}: CommandContext): Promise<void> {
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
      ? `Successfully joined the group. Group ID: ${groupId}`
      : "Successfully joined the group.";
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

export const joinCommand: CommandHandler = {
  commands: ["join", "joins"],
  description:
    "Tell the bot to join a WhatsApp group using an invite link. The bot joins on its own behalf. Example: /join https://chat.whatsapp.com/AbCdEfGhIjK.",
  permission: "isOwner",
  run: (_sock, _message, ctx) => handleJoinCommand(ctx),
};
