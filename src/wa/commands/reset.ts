import logger from "../../logger.js";
import config from "../../config.js";
import * as registry from "../../server/accountRegistry.js";
import type {
  CommandContext,
  CommandHandler,
} from "../command/CommandContext.js";

async function handleReset({
  chatId,
  chatType: _chatType,
  senderIsAdmin: _senderIsAdmin,
  senderIsOwner,
  contextMsgId: _contextMsgId,
  args,
  folderPath = config.dataDir,
  sock,
}: CommandContext): Promise<void> {
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

export const resetCommand: CommandHandler = {
  commands: ["reset", "resets", "clear", "clears"],
  description: "Clear the bot's conversation memory in this chat.",
  permission: "private or (isGroup and isAdmin) or isOwner",
  run: (_sock, _message, ctx) => handleReset(ctx),
};
