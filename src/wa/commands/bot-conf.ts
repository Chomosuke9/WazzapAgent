import config from "../../config.js";
import * as registry from "../../server/accountRegistry.js";
import {
  BOT_CONFIG_KEYS,
  DEFAULT_ACTIVATION_MESSAGE,
  isActivationRequired,
} from "../botConfig.js";
import type { CommandContext, CommandHandler } from "../command/CommandContext.js";

const USAGE = [
  "*/bot-conf — Bot configuration (owner only)*",
  "",
  "`/bot-conf activation-msg <text>` — set the message shown when the bot is tagged in a chat that isn't activated yet",
  "`/bot-conf activation-msg clear` — restore the default message",
  "`/bot-conf prompt-override <text>` — set the base prompt for chats that haven't set their own /prompt",
  "`/bot-conf prompt-override clear` — remove the base prompt",
  "`/bot-conf require-activation <on|off>` — require activation (overrides .env at runtime)",
  "",
  "_Type `/bot-conf` without arguments to see the current values._",
].join("\n");

function isClear(v: string): boolean {
  const t = v.trim().toLowerCase();
  return t === "clear" || t === "reset" || t === "-";
}

async function handleBotConf({ chatId, folderPath = config.dataDir, args, sock, repos }: CommandContext): Promise<void> {
  const trimmed = (args || "").trim();

  // No args → show usage + current values.
  if (!trimmed) {
    const activationMsg = repos!.settings.getBotConfig(BOT_CONFIG_KEYS.ACTIVATION_MSG);
    const promptOverride = repos!.settings.getPrompt("__global__");
    const requireAct = isActivationRequired(repos!);
    const status = [
      "",
      "*Current values:*",
      `• require-activation: ${requireAct ? "on" : "off"}`,
      `• activation-msg: ${activationMsg ? "(custom)" : "(default)"}`,
      `• prompt-override: ${promptOverride ? "(set)" : "(empty)"}`,
    ].join("\n");
    try {
      await sock.sendMessage(chatId, { text: `${USAGE}\n${status}` });
    } catch (err) { /* ignore */ }
    return;
  }

  // Split into subcommand + rest (preserve original casing for free-text values).
  const spaceIdx = trimmed.search(/\s/);
  const sub = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  const reply = async (text: string) => {
    try {
      await sock.sendMessage(chatId, { text });
    } catch (err) { /* ignore */ }
  };

  switch (sub) {
    case "activation-msg":
    case "activation_msg": {
      if (!rest) {
        await reply("Usage: `/bot-conf activation-msg <text>` or `clear`.");
        return;
      }
      if (isClear(rest)) {
        repos!.settings.setBotConfig(BOT_CONFIG_KEYS.ACTIVATION_MSG, null);
        await reply(`Activation message restored to default:\n\n${DEFAULT_ACTIVATION_MESSAGE}`);
        return;
      }
      repos!.settings.setBotConfig(BOT_CONFIG_KEYS.ACTIVATION_MSG, rest);
      await reply(`Activation message updated:\n\n${rest}`);
      return;
    }

    case "prompt-override":
    case "prompt_override": {
      if (!rest) {
        await reply("Usage: `/bot-conf prompt-override <text>` or `clear`.");
        return;
      }
      const value = isClear(rest) ? null : rest;
      // The default prompt lives in the __global__ chat_settings row (the same
      // fallback /prompt default writes), so there is one source of truth.
      repos!.settings.setDefaultPrompt(value);
      registry.sendReliableToClient(folderPath, {
        type: "invalidate_chat_settings",
        folderPath,
        chatId: "global",
      });
      await reply(value === null ? "Base prompt removed." : "Base prompt updated.");
      return;
    }

    case "require-activation":
    case "require_activation": {
      const v = rest.trim().toLowerCase();
      if (v !== "on" && v !== "off") {
        await reply("Usage: `/bot-conf require-activation on` or `off`.");
        return;
      }
      repos!.settings.setBotConfig(BOT_CONFIG_KEYS.REQUIRE_ACTIVATION, v);
      await reply(`Require activation is now: *${v}*.`);
      return;
    }

    default:
      await reply(`Unknown subcommand: \`${sub}\`\n\n${USAGE}`);
      return;
  }
}

export { handleBotConf };

export const botConfCommand: CommandHandler = {
  commands: ["bot-conf", "botconf"],
  description: "Configure the bot globally (applies to all chats): change the activation message, set the base system prompt, or enable/disable require-activation. Owner only.",
  permission: "owner",
  run: (_sock, _message, ctx) => handleBotConf(ctx),
};
