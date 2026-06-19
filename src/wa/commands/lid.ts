import logger from "../../logger.js";
import type {
  CommandContext,
  CommandHandler,
} from "../command/CommandContext.js";
import { resolveLidForPhone } from "../domain/participants.js";

/**
 * `/lid <phone number>` — resolve a phone number to its WhatsApp LID.
 *
 * WhatsApp now addresses group senders by an opaque LID (`…@lid`) instead of
 * their phone number, which makes a phone-number-only `BOT_OWNER_JIDS` hard to
 * configure. This finder prints the LID so you can paste it into
 * `BOT_OWNER_JIDS` (or just keep using the phone number — the gateway also
 * resolves owner LIDs automatically at connect time).
 *
 * Permission: `from_me or isOwner` — runnable from the bot's own linked phone
 * (the reliable bootstrap path, since it needs no owner detection) or by an
 * already-recognised owner. It is intentionally NOT public: it must not let
 * an arbitrary user escalate, and looking up someone's LID is mildly sensitive.
 * It only REPORTS the LID; it never grants ownership.
 */
async function handleLid({
  chatId,
  args,
  sock,
}: CommandContext): Promise<void> {
  const digits = String(args ?? "").replace(/\D/g, "");

  if (digits.length < 5) {
    await sock
      .sendMessage(chatId, {
        text:
          "Usage: /lid <phone number with country code>\n" +
          "Example: /lid 6281234567890",
      })
      .catch(() => {});
    return;
  }

  let reply: string;
  try {
    const lid = await resolveLidForPhone(sock, digits);
    if (lid) {
      reply =
        `LID for +${digits}:\n*${lid}*\n\n` +
        "Add it to BOT_OWNER_JIDS (comma-separated) for owner access — " +
        "or just keep the phone number; the bot resolves owner LIDs on connect.";
    } else {
      reply =
        `Couldn't resolve a LID for +${digits}. ` +
        "Make sure the number is on WhatsApp; it may help if that contact has " +
        "messaged the bot or shares a group with it, then try again.";
    }
  } catch (err) {
    logger.warn({ err, digits }, "/lid resolution failed");
    reply = "Failed to resolve LID (see logs).";
  }

  await sock.sendMessage(chatId, { text: reply }).catch(() => {});
}

export { handleLid };

export const lidCommand: CommandHandler = {
  commands: ["lid"],
  description:
    "Look up a WhatsApp LID from a phone number (to fill in BOT_OWNER_JIDS). Usage: /lid <number>",
  permission: "from_me or isOwner",
  isHidden: true,
  run: (_sock, _message, ctx) => handleLid(ctx),
};
