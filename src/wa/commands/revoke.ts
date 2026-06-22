import logger from "../../logger.js";
import type {
  CommandContext,
  CommandHandler,
} from "../command/CommandContext.js";

const USAGE =
  "Usage:\n" +
  "• `/revoke 5` — revoke a single activation code\n" +
  "• `/revoke 1,2,3` — revoke several codes at once\n" +
  "• `/revoke unused` — revoke every code that hasn't been used yet\n\n" +
  "Use /monitor to see the list of activation code IDs.";

async function handleRevoke({
  chatId,
  args,
  sock,
  repos,
}: CommandContext): Promise<void> {
  const activation = repos!.activation;

  async function reply(text: string): Promise<void> {
    try {
      await sock.sendMessage(chatId, { text });
    } catch (err) {
      logger.warn({ err, chatId }, "failed sending /revoke response");
    }
  }

  const raw = (args || "").trim();
  if (!raw) {
    await reply(USAGE);
    return;
  }

  // --- /revoke unused: clear every not-yet-used code (no chat loses access) ---
  if (raw.toLowerCase() === "unused") {
    const { revoked } = activation.revokeUnusedActivationCodes();
    if (revoked.length === 0) {
      await reply("There are no unused activation codes to revoke.");
      return;
    }
    const idList = revoked.map((r) => `#${r.id}`).join(", ");
    await reply(
      `Revoked ${revoked.length} unused activation code(s): ${idList}.`,
    );
    return;
  }

  // --- /revoke <id>[,<id>...]: one or more explicit IDs (comma or space) ---
  const tokens = raw.split(/[\s,]+/).filter(Boolean);
  const ids: number[] = [];
  const invalid: string[] = [];
  for (const token of tokens) {
    // Strict positive integer — rejects "abc", "-3", "1.5", "2x".
    if (/^\d+$/.test(token) && Number(token) > 0) {
      ids.push(Number(token));
    } else {
      invalid.push(token);
    }
  }

  // De-duplicate while preserving the order the owner typed.
  const uniqueIds = [...new Set(ids)];

  if (uniqueIds.length === 0) {
    await reply(
      `No valid IDs found${invalid.length ? ` (got: ${invalid.join(", ")})` : ""}.\n` +
        "IDs must be positive numbers, e.g. `/revoke 1,2,3` — or use `/revoke unused`.\n" +
        "Use /monitor to see the list of IDs.",
    );
    return;
  }

  const { revoked, notFound } = activation.revokeActivationCodes(uniqueIds);

  const lines: string[] = [];
  if (revoked.length > 0) {
    const idList = revoked.map((r) => `#${r.id}`).join(", ");
    lines.push(
      revoked.length === 1
        ? `Activation code ${idList} revoked successfully.`
        : `Revoked ${revoked.length} activation codes: ${idList}.`,
    );
    const usedOnes = revoked.filter((r) => r.wasUsed);
    if (usedOnes.length > 0) {
      const usedList = usedOnes.map((r) => `#${r.id}`).join(", ");
      lines.push(
        usedOnes.length === 1
          ? `${usedList} was already used by a chat, which now loses access too.`
          : `${usedList} were already used by chats, which now lose access too.`,
      );
    }
  }
  if (notFound.length > 0) {
    lines.push(`Not found: ${notFound.map((id) => `#${id}`).join(", ")}.`);
  }
  if (invalid.length > 0) {
    lines.push(`Ignored (not a valid ID): ${invalid.join(", ")}.`);
  }

  await reply(lines.join("\n"));
}

export { handleRevoke };

export const revokeCommand: CommandHandler = {
  commands: ["revoke"],
  description:
    "Revoke activation codes made by /generate. Accepts a single ID (/revoke 5), multiple IDs (/revoke 1,2,3), or /revoke unused to clear all not-yet-used codes. See /monitor for the list of IDs.",
  permission: "owner",
  run: (_sock, _message, ctx) => handleRevoke(ctx),
};
