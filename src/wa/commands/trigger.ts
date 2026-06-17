import config from "../../config.js";
import * as registry from "../../server/accountRegistry.js";
import { VALID_TRIGGERS } from "../../db/repositories/SettingsRepository.js";
import { parseConfigScope, scopeSuffix } from "./configScope.js";
import type { CommandContext, CommandHandler } from '../command/CommandContext.js';

const TRIGGER_DESCRIPTIONS: Record<string, string> = {
  tag: "bot @mentioned",
  tagall: "everyone tagged (@all)",
  reply: "replied to bot message",
  join: "new member joins group",
  name: "bot name mentioned in text",
};

async function handleTrigger({
  chatId,
  senderIsOwner,
  senderId: _senderId,
  args,
  folderPath = config.dataDir,
  sock,
  repos,
}: CommandContext): Promise<void> {

  if (!args) {
    const current = repos!.settings.getTriggers(chatId);
    if (current.size > 0) {
      const lines = [...current]
        .sort()
        .map((t) => `  - ${t}: ${TRIGGER_DESCRIPTIONS[t] || t}`);
      try {
        await sock.sendMessage(chatId, {
          text: "Current triggers:\n" + lines.join("\n"),
        });
      } catch (err) {
        /* ignore */
      }
    } else {
      try {
        await sock.sendMessage(chatId, {
          text: "No triggers enabled. Bot won't respond in prefix mode.\nUse `/trigger` all to enable all triggers.",
        });
      } catch (err) {
        /* ignore */
      }
    }
    return;
  }

  const parts = args.trim().toLowerCase().split(/\s+/);
  const scope = parseConfigScope(parts[0]);
  const isScoped = scope !== "chat";
  const cleaned = isScoped
    ? parts.slice(1).join(" ")
    : args.trim().toLowerCase();

  if (isScoped && !senderIsOwner) {
    try {
      await sock.sendMessage(chatId, {
        text: "Only bot owner can set global/default triggers.",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  const applyTriggers = (triggers: Set<string>): void => {
    if (scope === "default") {
      repos!.settings.setDefaultTriggers(triggers);
    } else if (scope === "global") {
      repos!.settings.setGlobalTriggers(triggers);
    } else {
      repos!.settings.setTriggers(chatId, triggers);
    }
    registry.sendReliableToClient(folderPath, {
      type: "invalidate_chat_settings",
      folderPath,
      chatId: isScoped ? "global" : chatId,
    });
  };

  if (cleaned === "all") {
    applyTriggers(VALID_TRIGGERS);
    try {
      await sock.sendMessage(chatId, {
        text:
          `All triggers enabled${scopeSuffix(scope)}: ` +
          [...VALID_TRIGGERS].sort().join(", "),
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  if (cleaned === "none") {
    applyTriggers(new Set());
    try {
      await sock.sendMessage(chatId, {
        text: `All triggers disabled${scopeSuffix(scope)}. Bot won't respond in prefix mode.`,
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  const requested = new Set(
    cleaned
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
  );
  const invalid = [...requested].filter((t) => !VALID_TRIGGERS.has(t));
  if (invalid.length > 0) {
    try {
      await sock.sendMessage(chatId, {
        text: `Invalid trigger(s): ${invalid.sort().join(", ")}\nValid: ${[...VALID_TRIGGERS].sort().join(", ")}`,
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  const current = repos!.settings.getTriggers(chatId);
  const toggledOn = new Set([...requested].filter((t) => !current.has(t)));
  const toggledOff = new Set([...requested].filter((t) => current.has(t)));
  const newTriggers = new Set([...current, ...toggledOn]);
  for (const t of toggledOff) newTriggers.delete(t);

  applyTriggers(newTriggers);

  const statusLines = [...requested]
    .sort()
    .map((t) => `  - ${t}: ${toggledOn.has(t) ? "enabled" : "disabled"}`);
  const activeStr =
    newTriggers.size > 0 ? [...newTriggers].sort().join(", ") : "none";
  try {
    await sock.sendMessage(chatId, {
      text: statusLines.join("\n") + `\nActive triggers: ${activeStr}`,
    });
  } catch (err) {
    /* ignore */
  }
}

export { handleTrigger };

export const triggerCommand: CommandHandler = {
  commands: ["trigger", "triggers"],
  description: "Configure the prefix response triggers in prefix/hybrid mode. Trigger types: tag (mentioned), tagall (on @all), reply (replying to a bot message), name (bot name mentioned), join (a new member joins). Example: /trigger reply on.",
  permission: "isGroup and (isAdmin or isOwner)",
  run: (_sock, _message, ctx) => handleTrigger(ctx),
};