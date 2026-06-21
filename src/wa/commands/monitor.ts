import logger from "../../logger.js";
import { getCachedGroupMetadata } from "../domain/groupContext.js";
import type {
  CommandContext,
  CommandHandler,
} from "../command/CommandContext.js";
import type { AccountContext } from "../../account/accountContext.js";

function formatDuration(expiresAt: string | null): string {
  if (!expiresAt) return "Permanent";
  const now = new Date();
  const expiry = new Date(expiresAt);
  const diffMs = expiry.getTime() - now.getTime();
  if (diffMs <= 0) return "Expired";
  const diffDays = Math.floor(diffMs / 86400000);
  const diffHours = Math.floor((diffMs % 86400000) / 3600000);
  const diffMinutes = Math.floor((diffMs % 3600000) / 60000);
  if (diffDays > 0) return `${diffDays} days ${diffHours} hours`;
  if (diffHours > 0) return `${diffHours} hours ${diffMinutes} minutes`;
  return `${diffMinutes} minutes`;
}

function formatDurationShort(expiresAt: string | null): string {
  if (!expiresAt) return "Permanent";
  const now = new Date();
  const expiry = new Date(expiresAt);
  const diffMs = expiry.getTime() - now.getTime();
  if (diffMs <= 0) return "Expired";
  const diffDays = Math.floor(diffMs / 86400000);
  const diffHours = Math.floor((diffMs % 86400000) / 3600000);
  if (diffDays > 0) return `${diffDays}d ${diffHours}h`;
  if (diffHours > 0) return `${diffHours}h`;
  return `${Math.floor(diffMs / 60000)}m`;
}

async function getChatName(
  ctx: AccountContext | undefined,
  chatId: string,
): Promise<string> {
  if (chatId.endsWith("@g.us")) {
    const metadata = ctx ? getCachedGroupMetadata(ctx, chatId) : null;
    if (metadata?.name) return metadata.name;
    return chatId;
  }
  return chatId;
}

async function handleMonitor({
  chatId,
  account,
  sock,
  repos,
}: CommandContext): Promise<void> {
  try {
    const codes = repos!.activation.getAllActivationCodes();
    const activations = repos!.activation.getAllActivations();

    const codeLines = [];
    for (const code of codes) {
      const typeLabel =
        code.type === "all"
          ? "all"
          : code.type === "group"
            ? "group"
            : "private";
      const durationLabel = code.days === 0 ? "Permanent" : `${code.days} days`;
      const statusIcon = code.used ? "✓" : "✗";
      let usedInfo = "Not used yet";
      if (code.used && code.usedBy) {
        const name = await getChatName(account, code.usedBy);
        usedInfo = name;
      } else if (code.used) {
        usedInfo = "Already used";
      }
      codeLines.push(
        `#${code.id} | ${code.code} | ${typeLabel} | ${durationLabel} | ${statusIcon} ${usedInfo}`,
      );
    }

    const activationLines = [];
    for (const act of activations) {
      const name = await getChatName(account, act.chatId);
      const remaining = formatDuration(act.expiresAt);
      activationLines.push(
        `${name} (${act.chatId}) | #${act.code} | Remaining: ${remaining}`,
      );
    }

    const sections = [];
    if (codeLines.length > 0) {
      sections.push("=== Activation Codes ===\n" + codeLines.join("\n"));
    } else {
      sections.push("=== Activation Codes ===\nNo activation codes yet.");
    }

    if (activationLines.length > 0) {
      sections.push("\n=== Activated Chats ===\n" + activationLines.join("\n"));
    } else {
      sections.push("\n=== Activated Chats ===\nNo activated chats yet.");
    }

    const text = sections.join("\n");
    await sock.sendMessage(chatId, { text });
  } catch (err) {
    logger.error({ err }, "failed /monitor");
    try {
      await sock.sendMessage(chatId, { text: "Failed to load monitor data." });
    } catch (e) {
      /* ignore */
    }
  }
}

export { handleMonitor, formatDuration, formatDurationShort };

export const monitorCommand: CommandHandler = {
  commands: ["monitor"],
  description: "Show a concise dashboard monitor for all chats (owner only).",
  permission: "owner",
  run: (_sock, _message, ctx) => handleMonitor(ctx),
};
