import config from "../../config.js";
import * as registry from "../../server/accountRegistry.js";
import type { AccountRepositories } from "../../db/repositories/index.js";
import { parseConfigScope, scopeSuffix, type ConfigScope } from "./configScope.js";
import type { CommandContext, CommandHandler } from '../commands/CommandContext.js';

async function applyAndNotify(repos: AccountRepositories, folderPath: string, scope: ConfigScope, chatId: string, enabled: boolean): Promise<void> {
  // Persist + notify the Python bridge so its in-process cache
  // (_subagent_enabled_cache) drops the stale value. Without the WS
  // notification, /subagent on would only take effect after a bridge
  // restart because the cache is per-process and never expires on its own.
  if (scope === "default") {
    repos.settings.setDefaultSubagentEnabled(enabled);
  } else if (scope === "global") {
    repos.settings.setGlobalSubagentEnabled(enabled);
  } else {
    repos.settings.setSubagentEnabled(chatId, enabled);
  }
  // For both global and default scopes the bridge must drop ALL cached
  // subagent values (untouched chats follow the __global__ fallback), so we
  // signal chatId:"global" which triggers a full settings-cache reset on the
  // Python side.
  registry.sendReliableToClient(folderPath, {
    type: "set_subagent_enabled",
    folderPath,
    chatId: scope === "chat" ? chatId : "global",
    enabled,
  });
}

async function handleSubagent({ chatId, senderIsOwner, args, folderPath = config.dataDir, sock, repos }: CommandContext): Promise<void> {

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
    const current = repos!.settings.getSubagentEnabled(chatId);
    try {
      await sock.sendMessage(chatId, {
        text:
          `Subagent: *${current ? "ON" : "OFF"}*\\n\\n` +
          "Enable subagent for this chat to allow LLM2 to call sub-agents for complex tasks.\\n\\n" +
          "_/subagent on_ - enable subagent\\n" +
          "_/subagent off_ - disable subagent\\n" +
          "_/subagent global on/off_ - enable/disable for all chats\\n" +
          "_/subagent default on/off_ - set for chats that haven't set their own",
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

  if (value === "on" || value === "off") {
    const enabled = value === "on";
    await applyAndNotify(repos!, folderPath, scope, chatId, enabled);
    try {
      await sock.sendMessage(chatId, {
        text: `Subagent ${enabled ? "enabled" : "disabled"}${scopeSuffix(scope)}.`,
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  try {
    await sock.sendMessage(chatId, {
      text: "Invalid. Use `/subagent on`, `/subagent off`, `/subagent global on/off`, or `/subagent default on/off`",
    });
  } catch (err) {
    /* ignore */
  }
}

export { handleSubagent };

export const subagentCommand: CommandHandler = { name: "subagent", aliases: ["subagents"], run: handleSubagent };