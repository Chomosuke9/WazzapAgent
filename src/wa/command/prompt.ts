import config from "../../config.js";
import * as registry from "../../server/accountRegistry.js";
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
          text: "No custom prompt set for this chat. Use `/prompt` <text> to set one.\nUse `/prompt global <text>` to set for all chats.",
        });
      } catch (err) {
        /* ignore */
      }
    }
    return;
  }

  const parts = args.trim().split(/\s+/);
  const isGlobal = parts[0].toLowerCase() === "global";
  const newArgs = isGlobal ? args.trim().slice(7).trim() : args.trim();

  if (isGlobal && !senderIsOwner) {
    try {
      await sock.sendMessage(chatId, {
        text: "Only bot owner can set global prompt.",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  if (isGlobal && !newArgs) {
    try {
      await sock.sendMessage(chatId, {
        text: "Usage: `/prompt global <text>`",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  if (
    newArgs.toLowerCase() === "-" ||
    newArgs.toLowerCase() === "clear" ||
    newArgs.toLowerCase() === "reset"
  ) {
    if (isGlobal) {
      repos!.settings.setGlobalPrompt(null);
      registry.sendReliableToClient(folderPath, {
        type: "invalidate_chat_settings",
        folderPath,
        chatId: "global",
      });
    } else {
      repos!.settings.setPrompt(chatId, null);
      registry.sendReliableToClient(folderPath, {
        type: "invalidate_chat_settings",
        folderPath,
        chatId,
      });
    }
    try {
      await sock.sendMessage(chatId, {
        text: `Custom prompt cleared${isGlobal ? " globally" : ""}. Bot will use the default.`,
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

  if (isGlobal) {
    repos!.settings.setGlobalPrompt(newArgs);
    registry.sendReliableToClient(folderPath, {
      type: "invalidate_chat_settings",
      folderPath,
      chatId: "global",
    });
  } else {
    repos!.settings.setPrompt(chatId, newArgs);
    registry.sendReliableToClient(folderPath, {
      type: "invalidate_chat_settings",
      folderPath,
      chatId,
    });
  }

  const preview =
    newArgs.length > 200 ? newArgs.slice(0, 197) + "..." : newArgs;
  try {
    await sock.sendMessage(chatId, {
      text: `Prompt updated${isGlobal ? " globally" : ""}:\n${preview}`,
    });
  } catch (err) {
    /* ignore */
  }
}

export { handlePrompt };

export const promptCommand: CommandHandler = { name: "prompt", aliases: ["prompts"], run: handlePrompt };