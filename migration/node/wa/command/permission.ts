import config from "../../config.js";
import * as registry from "../../server/accountRegistry.js";
import { getPermission, setPermission, setGlobalPermission } from "../../db.js";
import type { CommandContext } from "./parseCommand.js";

const PERMISSION_LABELS: Record<number, string> = {
  0: "0 (all moderation forbidden)",
  1: "1 (delete allowed)",
  2: "2 (delete & mute allowed)",
  3: "3 (delete, mute & kick allowed)",
};

async function handlePermission({
  chatId,
  chatType,
  senderIsAdmin,
  senderIsOwner,
  botIsAdmin,
  args,
  folderPath = config.dataDir,
  sock,
}: CommandContext): Promise<void> {

  if (chatType === "private") {
    try {
      await sock.sendMessage(chatId, {
        text: "`/permission` can only be used in group chats.",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  if (!senderIsOwner && !senderIsAdmin) {
    try {
      await sock.sendMessage(chatId, {
        text: "Only group admins or bot owner can use `/permission`.",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  if (!args) {
    const current = getPermission(chatId);
    const label = PERMISSION_LABELS[current] || String(current);
    try {
      await sock.sendMessage(chatId, {
        text:
          `Current permission level: ${label}\n\n` +
          "Usage: `/permission` 0, 1, 2, or 3.\n" +
          "Global usage: `/permission global` 0, 1, 2, or 3",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  const parts = args.trim().toLowerCase().split(/\s+/);
  const isGlobal = parts[0] === "global";
  const levelStr = isGlobal ? parts[1] : parts[0];
  const level = parseInt(levelStr, 10);

  if (isNaN(level)) {
    try {
      await sock.sendMessage(chatId, {
        text: "Usage: `/permission` 0, 1, 2, or 3. Use `/permission global` <level> to set for all chats.",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  if (level < 0 || level > 3) {
    try {
      await sock.sendMessage(chatId, {
        text: "Level must be 0-3.\n0: all forbidden\n1: delete\n2: delete & mute\n3: delete, mute & kick",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  if (level > 0 && !botIsAdmin && !isGlobal) {
    try {
      await sock.sendMessage(chatId, {
        text: "Bot must be an admin to enable moderation (permission 1-3). Promote the bot first, then try again.",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  if (isGlobal) {
    if (!senderIsOwner) {
      try {
        await sock.sendMessage(chatId, {
          text: "Only bot owner can set global permission.",
        });
      } catch (err) {
        /* ignore */
      }
      return;
    }
    setGlobalPermission(level);
    registry.sendReliableToClient(folderPath, {
      type: "invalidate_chat_settings",
      folderPath,
      chatId: "global",
    });
  } else {
    setPermission(chatId, level);
    registry.sendReliableToClient(folderPath, {
      type: "invalidate_chat_settings",
      folderPath,
      chatId,
    });
  }

  const label = PERMISSION_LABELS[level] || String(level);
  try {
    await sock.sendMessage(chatId, {
      text: `Permission updated${isGlobal ? " globally" : ""}: ${label}`,
    });
  } catch (err) {
    /* ignore */
  }
}

export { handlePermission };
