import logger from "../../logger.js";
import { listCommands } from "../command/CommandRegistry.js";
import type {
  CommandContext,
  CommandHandler,
} from "../command/CommandContext.js";

// `/help` is generated from the live command registry: every registered command
// contributes its canonical token + description, so adding a command (or editing
// its description) updates this listing automatically. Commands flagged
// `isHidden` are omitted. Owner-gated commands (permission contains the `owner`
// atom) are grouped into a separate section.

/** A command is owner-gated when its permission expression references `owner`. */
function isOwnerCommand(handler: CommandHandler): boolean {
  return /\bowner\b/.test(handler.permission);
}

function byCanonical(a: CommandHandler, b: CommandHandler): number {
  return a.commands[0].localeCompare(b.commands[0]);
}

function formatLine(handler: CommandHandler): string {
  return `- */\`${handler.commands[0]}\`*\n*Permission* : ${handler.permission}\n*Deskripsi* : ${handler.description}`;
}

/** Build the `/help` body from the current registry. */
function buildHelpText(): string {
  const visible = listCommands().filter((c) => !c.isHidden);
  const general = visible.filter((c) => !isOwnerCommand(c)).sort(byCanonical);
  const owner = visible.filter(isOwnerCommand).sort(byCanonical);

  const lines: string[] = ["*WazzapAgents — Daftar Perintah*"];

  lines.push("", "*Umum*", "");
  lines.push(general.map(formatLine).join("\n\n"));

  if (owner.length > 0) {
    lines.push("", "*Owner*", "");
    lines.push(owner.map(formatLine).join("\n\n"));
  }

  lines.push(
    "",
    "_Ketik sebagian perintah tanpa argumen untuk melihat status/nilai saat ini._",
  );

  return lines.join("\n");
}

async function handleHelp({ chatId, sock }: CommandContext): Promise<void> {
  try {
    await sock.sendMessage(chatId, { text: buildHelpText() });
  } catch (err) {
    logger.warn({ err, chatId }, "failed sending /help response");
  }
}

export { handleHelp, buildHelpText };

export const helpCommand: CommandHandler = {
  commands: ["help", "helps", "menu", "list"],
  description:
    "Tampilkan daftar lengkap semua perintah yang tersedia beserta level permission dan deskripsinya. Perintah tersembunyi tidak ditampilkan.",
  permission: "public",
  run: (_sock, _message, ctx) => handleHelp(ctx),
};
