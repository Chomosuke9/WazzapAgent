import config from "../../config.js";
import * as registry from "../../server/accountRegistry.js";
import { parseConfigScope, scopeSuffix } from "./configScope.js";
import type { CommandContext, CommandHandler } from '../command/CommandContext.js';

const PERMISSION_LABELS: Record<number, string> = {
  0: "0 (all moderation forbidden)",
  1: "1 (delete allowed)",
  2: "2 (delete & mute allowed)",
  3: "3 (delete, mute & kick allowed)",
};

async function handlePermission({
  chatId,
  senderIsOwner,
  botIsAdmin,
  args,
  folderPath = config.dataDir,
  sock,
  repos,
}: CommandContext): Promise<void> {

  if (!args) {
    const current = repos!.settings.getPermission(chatId);
    const label = PERMISSION_LABELS[current] || String(current);
    try {
      await sock.sendMessage(chatId, {
        text:
          `Current permission level: ${label}\n\n` +
          "Usage: `/permission` 0, 1, 2, or 3.\n" +
          "Global usage: `/permission global` 0-3 (all chats)\n" +
          "Default usage: `/permission default` 0-3 (chats that haven't set their own)",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  const parts = args.trim().toLowerCase().split(/\s+/);
  const scope = parseConfigScope(parts[0]);
  const isScoped = scope !== "chat";
  const levelStr = isScoped ? parts[1] : parts[0];
  const level = parseInt(levelStr, 10);

  if (isNaN(level)) {
    try {
      await sock.sendMessage(chatId, {
        text: "Usage: `/permission` 0, 1, 2, or 3. Use `/permission global` <level> for all chats, `/permission default` <level> for untouched chats.",
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

  if (level > 0 && !botIsAdmin && !isScoped) {
    try {
      await sock.sendMessage(chatId, {
        text: "Bot must be an admin to enable moderation (permission 1-3). Promote the bot first, then try again.",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  if (isScoped) {
    if (!senderIsOwner) {
      try {
        await sock.sendMessage(chatId, {
          text: "Only bot owner can set global/default permission.",
        });
      } catch (err) {
        /* ignore */
      }
      return;
    }
    if (scope === "default") {
      repos!.settings.setDefaultPermission(level);
    } else {
      repos!.settings.setGlobalPermission(level);
    }
    registry.sendReliableToClient(folderPath, {
      type: "invalidate_chat_settings",
      folderPath,
      chatId: "global",
    });
  } else {
    repos!.settings.setPermission(chatId, level);
    registry.sendReliableToClient(folderPath, {
      type: "invalidate_chat_settings",
      folderPath,
      chatId,
    });
  }

  const label = PERMISSION_LABELS[level] || String(level);
  try {
    await sock.sendMessage(chatId, {
      text: `Permission updated${scopeSuffix(scope)}: ${label}`,
    });
  } catch (err) {
    /* ignore */
  }
}

export { handlePermission };

export const permissionCommand: CommandHandler = {
  commands: ["permission", "permissions"],
  description: "Atur level izin moderasi untuk chat ini. Level 0 = tidak ada moderasi; level 1 = bot bisa hapus pesan; level 2 = + mute anggota; level 3 = + kick anggota. Tanpa argumen menampilkan level saat ini. Contoh: /permission 2.",
  permission: "isGroup and (isAdmin or isOwner)",
  run: (_sock, _message, ctx) => handlePermission(ctx),
};