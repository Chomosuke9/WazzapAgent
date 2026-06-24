import logger from "../../logger.js";
import { getDevice } from "baileys";
import { sendCopyCode } from "../interactive/index.js";
import { deviceToTier, tierAllows, copyCodeFallbackText } from "../interactive/compat.js";
import type {
  CommandContext,
  CommandHandler,
} from "../command/CommandContext.js";

async function handleGenerate({
  chatId,
  senderId,
  args,
  msg,
  sock,
  repos,
}: CommandContext): Promise<void> {
  const parts = (args || "").trim().split(/\s+/);

  if (parts.length < 2) {
    try {
      await sock.sendMessage(chatId, {
        text: "Usage: /generate <private|group|all> <num_days>/0\n\nExamples:\n/generate private 30\n/generate group 0\n/generate all 7",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  const type = parts[0].toLowerCase();
  const days = parseInt(parts[1], 10);

  const validTypes = new Set(["private", "group", "all"]);
  if (!validTypes.has(type)) {
    try {
      await sock.sendMessage(chatId, {
        text: "Type must be: private, group, or all",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  if (isNaN(days) || days < 0) {
    try {
      await sock.sendMessage(chatId, {
        text: "The number of days must be 0 or greater. 0 = permanent.",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  let code: string;
  try {
    const result = repos!.activation.generateActivationCode(
      type,
      days,
      senderId,
    );
    code = result.code;
  } catch (err) {
    logger.error({ err }, "failed generating activation code");
    try {
      await sock.sendMessage(chatId, {
        text: "Failed to create activation code.",
      });
    } catch (e) {
      /* ignore */
    }
    return;
  }

  const botName = sock.user?.name?.trim() || "this bot";
  const typeLabel =
    type === "all"
      ? "all (private & group)"
      : type === "group"
        ? "group"
        : "private";
  const durationLabel = days === 0 ? "Permanent" : `${days} days`;
  const activateCommand = `/activate ${code}`;

  const body =
    `*Activation code created successfully!*\n` +
    `Type: ${typeLabel}\n` +
    `Valid for: ${durationLabel}\n\n` +
    `Copy the code by tapping the button below, then send it to the group where you want ${botName} activated (or to ${botName}'s private chat).`;

  // Device gate: a cta_copy button doesn't render on `safe` (web/desktop), so
  // send the code in a monospace block (long-press to copy) for those callers.
  if (!tierAllows(deviceToTier(getDevice(msg?.key?.id || "")), "cta_copy")) {
    const fallbackBody =
      `*Activation code created successfully!*\n` +
      `Type: ${typeLabel}\n` +
      `Valid for: ${durationLabel}\n\n` +
      `Long-press the code below to copy it, then send it to the group where you want ${botName} activated (or to ${botName}'s private chat).`;
    try {
      await sock.sendMessage(chatId, {
        text: `${fallbackBody}\n\n${copyCodeFallbackText(activateCommand, "Copy Code")}`,
      });
    } catch (e) {
      /* ignore */
    }
    return;
  }

  try {
    await sendCopyCode(sock, chatId, body, activateCommand, "Copy Code", {
      footer:
        durationLabel === "Permanent"
          ? "Permanent activation"
          : `Valid for ${durationLabel}`,
    });
  } catch (err) {
    logger.warn(
      { err, chatId },
      "failed sending /generate cta_copy, falling back to text",
    );
    try {
      await sock.sendMessage(chatId, {
        text: `${body}\n\n${activateCommand}`,
      });
    } catch (e) {
      /* ignore */
    }
  }
}

export { handleGenerate };

export const generateCommand: CommandHandler = {
  commands: ["generate"],
  description:
    "Generate activation code to gain access to the bot (owner only). Example: /generate group 0.",
  isHidden: true,
  permission: "owner",
  run: (_sock, _message, ctx) => handleGenerate(ctx),
};
