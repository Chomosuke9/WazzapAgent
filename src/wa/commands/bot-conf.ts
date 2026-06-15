import config from "../../config.js";
import * as registry from "../../server/accountRegistry.js";
import {
  BOT_CONFIG_KEYS,
  DEFAULT_ACTIVATION_MESSAGE,
  isActivationRequired,
} from "../botConfig.js";
import type { CommandContext, CommandHandler } from "../command/CommandContext.js";

const USAGE = [
  "*/bot-conf — Konfigurasi bot (owner only)*",
  "",
  "`/bot-conf activation-msg <teks>` — atur pesan saat bot di-tag di chat yang belum diaktifkan",
  "`/bot-conf activation-msg clear` — kembalikan ke pesan bawaan",
  "`/bot-conf prompt-override <teks>` — atur prompt dasar untuk chat yang belum set /prompt sendiri",
  "`/bot-conf prompt-override clear` — hapus prompt dasar",
  "`/bot-conf require-activation <on|off>` — wajibkan aktivasi (override .env saat runtime)",
  "",
  "_Ketik `/bot-conf` tanpa argumen untuk melihat nilai saat ini._",
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
      "*Nilai saat ini:*",
      `• require-activation: ${requireAct ? "on" : "off"}`,
      `• activation-msg: ${activationMsg ? "(custom)" : "(bawaan)"}`,
      `• prompt-override: ${promptOverride ? "(diset)" : "(kosong)"}`,
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
        await reply("Penggunaan: `/bot-conf activation-msg <teks>` atau `clear`.");
        return;
      }
      if (isClear(rest)) {
        repos!.settings.setBotConfig(BOT_CONFIG_KEYS.ACTIVATION_MSG, null);
        await reply(`Pesan aktivasi dikembalikan ke bawaan:\n\n${DEFAULT_ACTIVATION_MESSAGE}`);
        return;
      }
      repos!.settings.setBotConfig(BOT_CONFIG_KEYS.ACTIVATION_MSG, rest);
      await reply(`Pesan aktivasi diperbarui:\n\n${rest}`);
      return;
    }

    case "prompt-override":
    case "prompt_override": {
      if (!rest) {
        await reply("Penggunaan: `/bot-conf prompt-override <teks>` atau `clear`.");
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
      await reply(value === null ? "Prompt dasar dihapus." : "Prompt dasar diperbarui.");
      return;
    }

    case "require-activation":
    case "require_activation": {
      const v = rest.trim().toLowerCase();
      if (v !== "on" && v !== "off") {
        await reply("Penggunaan: `/bot-conf require-activation on` atau `off`.");
        return;
      }
      repos!.settings.setBotConfig(BOT_CONFIG_KEYS.REQUIRE_ACTIVATION, v);
      await reply(`Wajib aktivasi sekarang: *${v}*.`);
      return;
    }

    default:
      await reply(`Subcommand tidak dikenal: \`${sub}\`\n\n${USAGE}`);
      return;
  }
}

export { handleBotConf };

export const botConfCommand: CommandHandler = {
  commands: ["bot-conf", "botconf"],
  description: "Konfigurasi bot secara global (berlaku untuk semua chat): ubah pesan aktivasi, atur system prompt dasar, atau aktifkan/nonaktifkan wajib-aktivasi. Khusus owner.",
  permission: "owner",
  run: (_sock, _message, ctx) => handleBotConf(ctx),
};
