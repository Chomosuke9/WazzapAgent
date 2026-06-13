import config from "../../config.js";
import * as registry from "../../server/accountRegistry.js";
import { parseConfigScope, scopeSuffix } from "./configScope.js";
import type { CommandContext, CommandHandler } from '../commands/CommandContext.js';

const PROMPT_MAX_CHARS = 4000;

async function handlePrompt({
  chatId,
  chatType,
  senderIsAdmin,
  senderIsOwner,
  args,
  folderPath = config.dataDir,
  sock,
  repos,
}: CommandContext): Promise<void> {
  const isPrivate = chatType === "private";

  if (isPrivate || senderIsOwner || senderIsAdmin) {
    // proceed
  } else {
    try {
      await sock.sendMessage(chatId, {
        text: "Only group admins can use `/prompt`.",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

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

export const promptCommand: CommandHandler = { name: "prompt", aliases: ["prompts"], run: handlePrompt };