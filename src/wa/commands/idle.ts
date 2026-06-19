import config from "../../config.js";
import * as registry from "../../server/accountRegistry.js";
import { parseConfigScope, scopeSuffix } from "./configScope.js";
import type {
  CommandContext,
  CommandHandler,
} from "../command/CommandContext.js";

type TriggerRange = { min: number; max: number };

function parseRange(value: string): TriggerRange | null {
  if (!value) return null;
  const rangeMatch = value.match(/^(\d+)\s*-\s*(\d+)$/);
  if (rangeMatch) {
    const min = parseInt(rangeMatch[1], 10);
    const max = parseInt(rangeMatch[2], 10);
    if (min > 0 && max > 0 && max >= min) return { min, max };
    return null;
  }
  const single = parseInt(value, 10);
  if (single > 0) return { min: single, max: single };
  return null;
}

function formatTrigger(trigger: TriggerRange | null): string {
  if (!trigger) return "OFF";
  if (trigger.min === trigger.max) return `${trigger.min} messages`;
  return `${trigger.min}-${trigger.max} messages`;
}

async function handleIdle({
  chatId,
  senderIsOwner,
  args,
  folderPath = config.dataDir,
  sock,
  repos,
}: CommandContext): Promise<void> {
  if (!args) {
    const current = repos!.settings.getIdleTrigger(chatId);
    try {
      await sock.sendMessage(chatId, {
        text:
          `Idle trigger: *${formatTrigger(current)}*\n\n` +
          "Auto-trigger LLM2 after N messages of silence.\n\n" +
          "_/idle 50_ — trigger after exactly 50 messages\n" +
          "_/idle 60-80_ — random trigger between 60-80 messages\n" +
          "_/idle off_ — disable idle trigger\n" +
          "_/idle global <value>_ — set for all chats\n" +
          "_/idle default <value>_ — set for chats that haven't set their own",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  const parts = args.trim().toLowerCase().split(/\s+/);
  const scope = parseConfigScope(parts[0]);
  const isScoped = scope !== "chat";
  const value = isScoped ? parts.slice(1).join(" ") : parts.join(" ");

  if (isScoped && !senderIsOwner) {
    try {
      await sock.sendMessage(chatId, {
        text: "Only bot owner can use `/idle global` / `/idle default`.",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  const applyIdle = (min: number | null, max: number | null): void => {
    if (scope === "default") {
      repos!.settings.setDefaultIdleTrigger(min, max);
    } else if (scope === "global") {
      repos!.settings.setGlobalIdleTrigger(min, max);
    } else {
      repos!.settings.setIdleTrigger(chatId, min, max);
    }
    registry.sendReliableToClient(folderPath, {
      type: "invalidate_chat_settings",
      folderPath,
      chatId: isScoped ? "global" : chatId,
    });
  };

  if (value === "off") {
    applyIdle(null, null);
    try {
      await sock.sendMessage(chatId, {
        text: `Idle trigger disabled${scopeSuffix(scope)}.`,
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  const range = parseRange(value);
  if (!range) {
    try {
      await sock.sendMessage(chatId, {
        text: "Invalid. Use `/idle 50`, `/idle 60-80`, or `/idle off`.",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  applyIdle(range.min, range.max);

  try {
    await sock.sendMessage(chatId, {
      text: `Idle trigger set${scopeSuffix(scope)}: *${formatTrigger(range)}*`,
    });
  } catch (err) {
    /* ignore */
  }
}

export { handleIdle };

export const idleCommand: CommandHandler = {
  commands: ["idle"],
  description:
    "Configure the idle trigger: the bot chimes in after a number of messages pass without a reply. Format: /idle <n> (after exactly n messages), /idle <min>-<max> (random within range), /idle off (disable). Example: /idle 5-10.",
  permission: "isGroup and (isAdmin or isOwner)",
  run: (_sock, _message, ctx) => handleIdle(ctx),
};
