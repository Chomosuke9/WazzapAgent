import config from "../../config.js";
import * as registry from "../../server/accountRegistry.js";
import { getPrompt, setPrompt, setGlobalPrompt } from "../../db.js";
import type { CommandContext } from "./parseCommand.js";

const PROMPT_MAX_CHARS = 4000;

async function handlePrompt({
  chatId,
  chatType,
  senderIsAdmin,
  senderIsOwner,
  args,
  folderPath = config.dataDir,
  sock,
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
    const current = getPrompt(chatId);
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
      setGlobalPrompt(null);
      registry.sendReliableToClient(folderPath, {
        type: "invalidate_chat_settings",
        folderPath,
        chatId: "global",
      });
    } else {
      setPrompt(chatId, null);
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
    setGlobalPrompt(newArgs);
    registry.sendReliableToClient(folderPath, {
      type: "invalidate_chat_settings",
      folderPath,
      chatId: "global",
    });
  } else {
    setPrompt(chatId, newArgs);
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
