import config from "../../config.js";
import * as registry from "../../server/accountRegistry.js";
import {
  getSubagentEnabled,
  setSubagentEnabled,
  setGlobalSubagentEnabled,
} from "../../db.js";
import type { CommandContext } from "./parseCommand.js";

async function applyAndNotify(folderPath: string, chatId: string, enabled: boolean): Promise<void> {
  // Persist + notify the Python bridge so its in-process cache
  // (_subagent_enabled_cache) drops the stale value. Without the WS
  // notification, /subagent on would only take effect after a bridge
  // restart because the cache is per-process and never expires on its own.
  if (chatId === "global") {
    setGlobalSubagentEnabled(enabled);
  } else {
    setSubagentEnabled(chatId, enabled);
  }
  registry.sendReliableToClient(folderPath, {
    type: "set_subagent_enabled",
    folderPath,
    chatId,
    enabled,
  });
}

async function handleSubagent({ chatId, senderIsOwner, args, folderPath = config.dataDir, sock }: CommandContext): Promise<void> {

  if (!senderIsOwner) {
    try {
      await sock.sendMessage(chatId, {
        text: "Only bot owner can use `/subagent`.",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  if (!args) {
    const current = getSubagentEnabled(chatId);
    try {
      await sock.sendMessage(chatId, {
        text:
          `Subagent: *${current ? "ON" : "OFF"}*\\n\\n` +
          "Enable subagent for this chat to allow LLM2 to call sub-agents for complex tasks.\\n\\n" +
          "_/subagent on_ - enable subagent\\n" +
          "_/subagent off_ - disable subagent\\n" +
          "_/subagent global on/off_ - enable/disable for all chats",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  const parts = args.trim().toLowerCase().split(/\s+/);
  const isGlobal = parts[0] === "global";
  const value = isGlobal ? parts[1] : parts[0];
  const targetId = isGlobal ? "global" : chatId;

  if (value === "on") {
    await applyAndNotify(folderPath, targetId, true);
    try {
      await sock.sendMessage(chatId, {
        text: `Subagent enabled${isGlobal ? " globally" : ""}.`,
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  if (value === "off") {
    await applyAndNotify(folderPath, targetId, false);
    try {
      await sock.sendMessage(chatId, {
        text: `Subagent disabled${isGlobal ? " globally" : ""}.`,
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  try {
    await sock.sendMessage(chatId, {
      text: "Invalid. Use `/subagent on`, `/subagent off`, or `/subagent global on/off`",
    });
  } catch (err) {
    /* ignore */
  }
}

export { handleSubagent };
