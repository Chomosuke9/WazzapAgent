// /compat — set the interactive-message "compatibility mode" for this chat.
//
// Mirrors the /setting "Compatibility" menu section as a typed command so it is
// reachable from the TEXT settings menu too (iOS/web/desktop callers can't tap
// the single_select menu). The mode is read only by the Node gateway when it
// decides whether to send interactive messages, so — unlike /mode — it needs no
// `invalidate_chat_settings` broadcast to the Python bridge.
import { parseConfigScope, scopeSuffix } from "./configScope.js";
import { VALID_COMPAT_MODES } from "../../db/repositories/SettingsRepository.js";
import type { CommandContext, CommandHandler } from "../command/CommandContext.js";

const COMPAT_LABELS: Record<string, string> = {
  auto: "match the chat's device (Android→full, iOS→semi, web/desktop→safe)",
  full: "all interactive features (Android)",
  semi: "no list / single-select menus (iOS-safe)",
  safe: "plain text only — works everywhere, including WhatsApp Web",
};

async function handleCompat({
  chatId,
  senderIsOwner,
  args,
  sock,
  repos,
}: CommandContext): Promise<void> {
  if (!args || !args.trim()) {
    const current = repos!.settings.getCompatibilityMode(chatId);
    try {
      await sock.sendMessage(chatId, {
        text:
          `Current compatibility mode: *${current}* — ${COMPAT_LABELS[current] || ""}\n\n` +
          "Usage: `/compat` auto | full | semi | safe\n" +
          "- *auto*: match the chat's device automatically\n" +
          "- *full*: all interactive (Android)\n" +
          "- *semi*: no list menus (iOS)\n" +
          "- *safe*: plain text only (web/desktop)\n\n" +
          "Owner: `/compat global <mode>` (all chats), `/compat default <mode>` (untouched chats)",
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

  if (!mode || !VALID_COMPAT_MODES.has(mode)) {
    try {
      await sock.sendMessage(chatId, {
        text: "Invalid mode. Choose: auto, full, semi, or safe.",
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
          text: "Only the bot owner can set global/default compatibility mode.",
        });
      } catch (err) {
        /* ignore */
      }
      return;
    }
    if (scope === "default") {
      repos!.settings.setDefaultCompatibilityMode(mode);
    } else {
      repos!.settings.setGlobalCompatibilityMode(mode);
    }
  } else {
    repos!.settings.setCompatibilityMode(chatId, mode);
  }

  try {
    await sock.sendMessage(chatId, {
      text: `Compatibility mode updated${scopeSuffix(scope)}: *${mode}*`,
    });
  } catch (err) {
    /* ignore */
  }
}

export { handleCompat };

export const compatCommand: CommandHandler = {
  commands: ["compat", "compatibility"],
  description:
    "Set which interactive message features the bot uses in this chat. auto = match the chat's device; full = all (Android); semi = no list menus (iOS); safe = plain text only (works on WhatsApp Web). Without arguments it shows the current mode. Example: /compat safe.",
  permission: "isPrivate or isAdmin or isOwner",
  run: (_sock, _message, ctx) => handleCompat(ctx),
};
