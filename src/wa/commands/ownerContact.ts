import logger from "../../logger.js";
import type { CommandContext, CommandHandler } from '../command/CommandContext.js';

/**
 * Strip all non-digit characters to produce a WhatsApp ID (waid).
 * e.g. "+1 (581) 287-2385" → "15812872385"
 */
function stripToDigits(phoneNumber: string): string {
  return String(phoneNumber).replace(/\D/g, "");
}

/**
 * Build a vCard 3.0 string from a phone number and display name.
 *
 * Example output:
 *   BEGIN:VCARD
 *   VERSION:3.0
 *   N:Agus Kebab;;;;
 *   FN:Agus Kebab
 *   item1.TEL;waid=6280000000000:+6280000000000
 *   item1.X-ABLabel:Ponsel
 *   END:VCARD
 */
function buildVcard(phoneNumber: string, displayName: string): string {
  const waid = stripToDigits(phoneNumber);
  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `N:${displayName};;;;`,
    `FN:${displayName}`,
    `item1.TEL;waid=${waid}:${phoneNumber}`,
    "item1.X-ABLabel:Ponsel",
    "END:VCARD",
  ].join("\n");
}

/**
 * Parse the "set" subcommand arguments.
 * Expected format: set "<phoneNumber>" "<displayName>"
 * Both values must be enclosed in double quotes.
 */
function parseSetArgs(args: string): { phoneNumber: string; displayName: string } | null {
  if (!args || !args.startsWith("set ")) return null;
  const rest = args.slice(4).trim();

  // Match two quoted strings: "phoneNumber" "displayName"
  const match = rest.match(/^"([^"]+)"\s+"([^"]+)"$/);
  if (!match) return null;

  const phoneNumber = match[1].trim();
  const displayName = match[2].trim();
  if (!phoneNumber || !displayName) return null;

  return { phoneNumber, displayName };
}

async function handleOwnerContact({
  chatId,
  chatType: _chatType,
  senderIsAdmin: _senderIsAdmin,
  senderIsOwner,
  args,
  sock,
  repos,
}: CommandContext): Promise<void> {
  const rawArgs = typeof args === "string" ? args.trim() : "";

  // ── No args: send stored contact card ──
  if (!rawArgs) {
    const contact = repos!.settings.getOwnerContact();
    if (!contact) {
      try {
        await sock.sendMessage(chatId, {
          text: 'Owner contact has not been set yet. The bot owner can set it with:\n/owner-contact set "number" "name"',
        });
      } catch (err) {
        logger.warn(
          { err, chatId },
          "failed sending /owner-contact not-set response",
        );
      }
      return;
    }

    const vcard = buildVcard(contact.phoneNumber, contact.displayName);
    try {
      await sock.sendMessage(chatId, {
        contacts: {
          displayName: contact.displayName,
          contacts: [{ vcard, displayName: contact.displayName }],
        },
      });
    } catch (err) {
      logger.warn(
        { err, chatId },
        "failed sending /owner-contact contact card",
      );
    }
    return;
  }

  // ── Permission check for set: only bot owner ──
  if (!senderIsOwner) {
    try {
      await sock.sendMessage(chatId, {
        text: "Only the bot owner can set the owner contact.",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  const parsed = parseSetArgs(rawArgs);
  if (!parsed) {
    try {
      await sock.sendMessage(chatId, {
        text: 'Invalid format. Usage:\n/owner-contact set "+6280000000000" "Agus Kebab"',
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  repos!.settings.setOwnerContact(parsed.phoneNumber, parsed.displayName);
  try {
    await sock.sendMessage(chatId, {
      text: `Owner contact updated: *${parsed.displayName}* (${parsed.phoneNumber})`,
    });
  } catch (err) {
    logger.warn(
      { err, chatId },
      "failed sending /owner-contact set confirmation",
    );
  }
}

export { handleOwnerContact };

export const ownerContactCommand: CommandHandler = {
  commands: ["owner-contact"],
  description: "Kirim kartu kontak owner bot ke chat ini. Owner dapat mengatur kontak yang dikirim menggunakan /owner-contact set <nomor>.",
  permission: "public",
  run: (_sock, _message, ctx) => handleOwnerContact(ctx),
};