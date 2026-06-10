import config from "../../config.js";
import * as registry from "../../server/accountRegistry.js";
import {
  getAnnouncementEnabled,
  setAnnouncementEnabled,
  setGlobalAnnouncementEnabled,
} from "../../db.js";
import type { CommandContext } from "./parseCommand.js";

async function handleAnnouncement({
  chatId,
  chatType,
  senderIsAdmin,
  senderIsOwner,
  args,
  folderPath = config.dataDir,
  sock,
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
    const current = getAnnouncementEnabled(chatId);
    try {
      await sock.sendMessage(chatId, {
        text:
          `Announcement broadcasts: *${current ? "ON" : "OFF"}*\n\n` +
          "_/announcement on_ — receive broadcasts in this group\n" +
          "_/announcement off_ — opt out of broadcasts in this group\n" +
          "_/announcement global on/off_ — set default for all groups (owner only)",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  const parts = args.trim().toLowerCase().split(/\s+/);
  const isGlobal = parts[0] === "global";
  const value = isGlobal ? parts[1] : parts[0];

  if (isGlobal && !senderIsOwner) {
    try {
      await sock.sendMessage(chatId, {
        text: "Only bot owner can set global announcement.",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  if (value === "on" || value === "off") {
    const enabled = value === "on";
    if (isGlobal) {
      setGlobalAnnouncementEnabled(enabled);
      registry.sendReliableToClient(folderPath, {
        type: "invalidate_chat_settings",
        folderPath,
        chatId: "global",
      });
    } else {
      setAnnouncementEnabled(chatId, enabled);
      registry.sendReliableToClient(folderPath, {
        type: "invalidate_chat_settings",
        folderPath,
        chatId,
      });
    }
    try {
      await sock.sendMessage(chatId, {
        text: `Announcement broadcasts ${enabled ? "enabled" : "disabled"}${isGlobal ? " globally" : ""}.`,
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  try {
    await sock.sendMessage(chatId, {
      text: "Usage: `/announcement on`, `/announcement off`, or `/announcement global on/off`",
    });
  } catch (err) {
    /* ignore */
  }
}

export { handleAnnouncement };
