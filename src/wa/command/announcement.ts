import config from "../../config.js";
import * as registry from "../../server/accountRegistry.js";
import { parseConfigScope, scopeSuffix } from "./configScope.js";
import type { CommandContext, CommandHandler } from '../commands/CommandContext.js';

async function handleAnnouncement({
  chatId,
  chatType,
  senderIsAdmin,
  senderIsOwner,
  args,
  folderPath = config.dataDir,
  sock,
  repos,
}: CommandContext): Promise<void> {

  if (chatType === "private") {
    try {
      await sock.sendMessage(chatId, {
        text: "`/announcement` can only be used in group chats.",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  if (!senderIsOwner && !senderIsAdmin) {
    try {
      await sock.sendMessage(chatId, {
        text: "Only group admins can use `/announcement`.",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  if (!args) {
    const current = repos!.settings.getAnnouncementEnabled(chatId);
    try {
      await sock.sendMessage(chatId, {
        text:
          `Announcement broadcasts: *${current ? "ON" : "OFF"}*\n\n` +
          "_/announcement on_ — receive broadcasts in this group\n" +
          "_/announcement off_ — opt out of broadcasts in this group\n" +
          "_/announcement global on/off_ — set default for all groups (owner only)\n" +
          "_/announcement default on/off_ — set for groups that haven't set their own (owner only)",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  const parts = args.trim().toLowerCase().split(/\s+/);
  const scope = parseConfigScope(parts[0]);
  const isScoped = scope !== "chat";
  const value = isScoped ? parts[1] : parts[0];

  if (isScoped && !senderIsOwner) {
    try {
      await sock.sendMessage(chatId, {
        text: "Only bot owner can set global/default announcement.",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  if (value === "on" || value === "off") {
    const enabled = value === "on";
    if (scope === "default") {
      repos!.settings.setDefaultAnnouncementEnabled(enabled);
    } else if (scope === "global") {
      repos!.settings.setGlobalAnnouncementEnabled(enabled);
    } else {
      repos!.settings.setAnnouncementEnabled(chatId, enabled);
    }
    registry.sendReliableToClient(folderPath, {
      type: "invalidate_chat_settings",
      folderPath,
      chatId: isScoped ? "global" : chatId,
    });
    try {
      await sock.sendMessage(chatId, {
        text: `Announcement broadcasts ${enabled ? "enabled" : "disabled"}${scopeSuffix(scope)}.`,
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  try {
    await sock.sendMessage(chatId, {
      text: "Usage: `/announcement on`, `/announcement off`, `/announcement global on/off`, or `/announcement default on/off`",
    });
  } catch (err) {
    /* ignore */
  }
}

export { handleAnnouncement };

export const announcementCommand: CommandHandler = { name: "announcement", aliases: ["announcements"], run: handleAnnouncement };