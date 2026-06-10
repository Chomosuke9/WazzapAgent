import logger from "../../logger.js";
import config from "../../config.js";
import * as registry from "../../server/accountRegistry.js";
import type { CommandContext } from "./parseCommand.js";

async function handleReset({
  chatId,
  chatType,
  senderIsAdmin,
  senderIsOwner,
  contextMsgId,
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
        text: "Only group admins can use `/reset`.",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  const isGlobal = args?.trim().toLowerCase() === "global";
  if (isGlobal && !senderIsOwner) {
    try {
      await sock.sendMessage(chatId, {
        text: "Only bot owner can perform a global reset.",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  const targetId = isGlobal ? "global" : chatId;
  registry.sendReliableToClient(folderPath, {
    type: "clear_history",
    folderPath,
    chatId: targetId,
  });

  try {
    const text = isGlobal
      ? "Bot memory for all chats has been reset."
      : "Bot memory for this chat has been reset.";
    await sock.sendMessage(chatId, { text });
  } catch (err) {
    /* ignore */
  }

  logger.info({ chatId, isGlobal }, "Memory cleared via /reset");
}

export { handleReset };
