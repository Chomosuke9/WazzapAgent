// /mode — set the response mode for this chat (auto | prefix | hybrid).
//
// The mode picker had been folded into the /setting `single_select` menu
// (the `mode_select:` button), which only renders on Android. This restores a
// typed command so the TEXT settings menu (iOS/web/desktop) can set it too.
// Auto/Hybrid route through the LLM1 router, so they are refused when LLM1 is
// not configured (matching the `mode_select:` button), and the change is
// broadcast to the Python bridge via `invalidate_chat_settings`.
import config from "../../config.js";
import * as registry from "../../server/accountRegistry.js";
import { parseConfigScope, scopeSuffix } from "./configScope.js";
import { VALID_MODES } from "../../db/repositories/SettingsRepository.js";
import type { CommandContext, CommandHandler } from "../command/CommandContext.js";

async function handleMode({
  chatId,
  senderIsOwner,
  args,
  folderPath = config.dataDir,
  sock,
  repos,
}: CommandContext): Promise<void> {
  if (!args || !args.trim()) {
    const current = repos!.settings.getMode(chatId);
    try {
      await sock.sendMessage(chatId, {
        text:
          `Current mode: *${current}*\n\n` +
          "Usage: `/mode` auto | prefix | hybrid\n" +
          "- *auto*: the LLM decides when to respond\n" +
          "- *prefix*: only responds when triggered\n" +
          "- *hybrid*: prefix first, fallback to auto\n\n" +
          "Owner: `/mode global <mode>` (all chats), `/mode default <mode>` (untouched chats)",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  const parts = args.trim().toLowerCase().split(/\s+/);
  const scope = parseConfigScope(parts[0]);
  const isScoped = scope !== "chat";
  const mode = isScoped ? parts[1] : parts[0];

  if (!mode || !VALID_MODES.has(mode)) {
    try {
      await sock.sendMessage(chatId, {
        text: "Invalid mode. Choose auto, prefix, or hybrid.",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  // Auto/Hybrid need the LLM1 router; prefix works without it.
  if (mode !== "prefix" && !config.llm1Configured) {
    try {
      await sock.sendMessage(chatId, {
        text:
          "Auto and Hybrid modes need the LLM1 router, which isn't configured yet. " +
          "Set LLM1_ENDPOINT (plus LLM1_MODEL and LLM1_API_KEY) in your .env and " +
          "restart the bot. Prefix mode works without it.",
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
          text: "Only the bot owner can set global/default mode.",
        });
      } catch (err) {
        /* ignore */
      }
      return;
    }
    if (scope === "default") {
      repos!.settings.setDefaultMode(mode);
    } else {
      repos!.settings.setGlobalMode(mode);
    }
    registry.sendReliableToClient(folderPath, {
      type: "invalidate_chat_settings",
      folderPath,
      chatId: "global",
    });
  } else {
    repos!.settings.setMode(chatId, mode);
    registry.sendReliableToClient(folderPath, {
      type: "invalidate_chat_settings",
      folderPath,
      chatId,
    });
  }

  try {
    await sock.sendMessage(chatId, {
      text: `Mode updated${scopeSuffix(scope)}: *${mode}*`,
    });
  } catch (err) {
    /* ignore */
  }
}

export { handleMode };

export const modeCommand: CommandHandler = {
  commands: ["mode"],
  description:
    "Set the response mode for this chat: auto (the LLM decides when to respond), prefix (only when triggered), or hybrid (prefix first, then auto). Without arguments it shows the current mode. Example: /mode hybrid.",
  permission: "isPrivate or isAdmin or isOwner",
  run: (_sock, _message, ctx) => handleMode(ctx),
};
