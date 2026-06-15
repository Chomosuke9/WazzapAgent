import config from "../../config.js";
import * as registry from "../../server/accountRegistry.js";
import { parseConfigScope, scopeSuffix } from "./configScope.js";
import type { CommandContext, CommandHandler } from '../command/CommandContext.js';

const PROMPT_MAX_CHARS = 4000;

async function handlePrompt({
  chatId,
  senderIsOwner,
  args,
  folderPath = config.dataDir,
  sock,
  repos,
}: CommandContext): Promise<void> {
  if (!args) {
    const current = repos!.settings.getPrompt(chatId);
    if (current) {
      try {
        await sock.sendMessage(chatId, { text: `Current prompt:\n${current}` });
      } catch (err) {
        /* ignore */
      }
    } else {
      try {
        await sock.sendMessage(chatId, {
          text: "No custom prompt set for this chat. Use `/prompt` <text> to set one.\nUse `/prompt global <text>` for all chats, or `/prompt default <text>` for chats that haven't set their own.",
        });
      } catch (err) {
        /* ignore */
      }
    }
    return;
  }

  const parts = args.trim().split(/\s+/);
  const scope = parseConfigScope(parts[0].toLowerCase());
  const isScoped = scope !== "chat";
  const newArgs = isScoped ? args.trim().replace(/^\S+\s*/, "").trim() : args.trim();

  if (isScoped && !senderIsOwner) {
    try {
      await sock.sendMessage(chatId, {
        text: "Only bot owner can set global/default prompt.",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  if (isScoped && !newArgs) {
    try {
      await sock.sendMessage(chatId, {
        text: `Usage: \`/prompt ${scope} <text>\``,
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  const applyPrompt = (value: string | null): void => {
    if (scope === "default") {
      repos!.settings.setDefaultPrompt(value);
    } else if (scope === "global") {
      repos!.settings.setGlobalPrompt(value);
    } else {
      repos!.settings.setPrompt(chatId, value);
    }
    registry.sendReliableToClient(folderPath, {
      type: "invalidate_chat_settings",
      folderPath,
      chatId: isScoped ? "global" : chatId,
    });
  };

  if (
    newArgs.toLowerCase() === "-" ||
    newArgs.toLowerCase() === "clear" ||
    newArgs.toLowerCase() === "reset"
  ) {
    applyPrompt(null);
    try {
      await sock.sendMessage(chatId, {
        text: `Custom prompt cleared${scopeSuffix(scope)}. Bot will use the default.`,
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  if (newArgs.length > PROMPT_MAX_CHARS) {
    try {
      await sock.sendMessage(chatId, {
        text: `Prompt too long (${newArgs.length} chars). Maximum is ${PROMPT_MAX_CHARS} characters.`,
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  applyPrompt(newArgs);

  const preview =
    newArgs.length > 200 ? newArgs.slice(0, 197) + "..." : newArgs;
  try {
    await sock.sendMessage(chatId, {
      text: `Prompt updated${scopeSuffix(scope)}:\n${preview}`,
    });
  } catch (err) {
    /* ignore */
  }
}

export { handlePrompt };

export const promptCommand: CommandHandler = {
  commands: ["prompt", "prompts"],
  description: "Atur instruksi atau kepribadian bot khusus untuk chat ini (system prompt). Tanpa argumen menampilkan prompt saat ini. Gunakan /prompt clear untuk menghapus. Contoh: /prompt Jawab dengan singkat, sopan, dan dalam bahasa Indonesia.",
  permission: "isPrivate or isAdmin or isOwner",
  run: (_sock, _message, ctx) => handlePrompt(ctx),
};