import type { WAMessage } from "baileys";
import config from "../../config.js";
import * as registry from "../../server/accountRegistry.js";
import { parseConfigScope, scopeSuffix } from "./configScope.js";
import {
  normalizeJid,
  mentionHandleForJid,
  rememberSenderRef,
} from "../domain/identifiers.js";
import { unwrapMessage, extractMentionedJids } from "../domain/messageParser.js";
import { resolveParticipantLabel } from "../events.js";
import { escapeRegex } from "../utils.js";
import type { AccountContext } from "../../account/accountContext.js";
import type { CommandContext, CommandHandler } from '../command/CommandContext.js';

const PROMPT_MAX_CHARS = 4000;

/**
 * Rewrite raw WhatsApp `@<localpart>` mention tokens in a `/prompt` body into
 * the canonical `@Name (senderRef)` form that the outbound renderer
 * (`renderOutboundMentions`) understands.
 *
 * WhatsApp never puts display names in the message text — a mention shows up in
 * the body as `@<localpart>` (the numeric local part of the mentioned JID:
 * phone number for `@s.whatsapp.net`, or LID number for `@lid`). The real full
 * JIDs live only in `contextInfo.mentionedJid`. Storing the raw text verbatim
 * therefore persists a useless `@<number>`; rewriting to `@Name (senderRef)`
 * makes it round-trip-correct on send.
 *
 * Best-effort: if extraction/resolution fails for a token it is left untouched.
 * Returns `text` unchanged when there are no mentions.
 */
async function rewritePromptMentions(
  ctx: AccountContext,
  chatId: string,
  text: string,
  msg: WAMessage,
): Promise<string> {
  if (!text) return text;

  let mentionedJids: string[] | null = null;
  try {
    const { message: inner } = unwrapMessage(msg?.message);
    mentionedJids = extractMentionedJids(inner);
  } catch {
    return text;
  }
  if (!mentionedJids || mentionedJids.length === 0) return text;

  let result = text;
  for (const jid of mentionedJids) {
    try {
      const normalized = normalizeJid(jid) || jid;
      if (!normalized) continue;
      const handle = mentionHandleForJid(normalized);
      if (!handle) continue;
      const senderRef = rememberSenderRef(ctx, chatId, normalized, normalized);
      if (!senderRef) continue;
      const name = await resolveParticipantLabel(ctx, chatId, normalized);
      const display = name || handle.slice(1);
      // Whole-token match only: the handle must not be a prefix of a longer
      // mention token (e.g. `@628123` must not match inside `@6281234`).
      const pattern = new RegExp(`${escapeRegex(handle)}(?![0-9A-Za-z._-])`, "g");
      result = result.replace(pattern, `@${display} (${senderRef})`);
    } catch (err) {
      // best-effort: leave this token as-is and continue
    }
  }
  return result;
}

async function handlePrompt({
  chatId,
  senderIsOwner,
  args,
  folderPath = config.dataDir,
  sock,
  repos,
  account,
  msg,
}: CommandContext): Promise<void> {
  if (!args) {
    const current = repos!.settings.getPrompt(chatId);
    if (current) {
      try {
        await sock.sendMessage(chatId, { text: `Current prompt:\n${current}` });
      } catch (err) {
        /* ignore */
      }
    } else {
      try {
        await sock.sendMessage(chatId, {
          text: "No custom prompt set for this chat. Use `/prompt` <text> to set one.\nUse `/prompt global <text>` for all chats, or `/prompt default <text>` for chats that haven't set their own.",
        });
      } catch (err) {
        /* ignore */
      }
    }
    return;
  }

  const parts = args.trim().split(/\s+/);
  const scope = parseConfigScope(parts[0].toLowerCase());
  const isScoped = scope !== "chat";
  let newArgs = isScoped ? args.trim().replace(/^\S+\s*/, "").trim() : args.trim();

  if (isScoped && !senderIsOwner) {
    try {
      await sock.sendMessage(chatId, {
        text: "Only bot owner can set global/default prompt.",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  if (isScoped && !newArgs) {
    try {
      await sock.sendMessage(chatId, {
        text: `Usage: \`/prompt ${scope} <text>\``,
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  const applyPrompt = (value: string | null): void => {
    if (scope === "default") {
      repos!.settings.setDefaultPrompt(value);
    } else if (scope === "global") {
      repos!.settings.setGlobalPrompt(value);
    } else {
      repos!.settings.setPrompt(chatId, value);
    }
    registry.sendReliableToClient(folderPath, {
      type: "invalidate_chat_settings",
      folderPath,
      chatId: isScoped ? "global" : chatId,
    });
  };

  if (
    newArgs.toLowerCase() === "-" ||
    newArgs.toLowerCase() === "clear" ||
    newArgs.toLowerCase() === "reset"
  ) {
    applyPrompt(null);
    try {
      await sock.sendMessage(chatId, {
        text: `Custom prompt cleared${scopeSuffix(scope)}. Bot will use the default.`,
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  // Rewrite raw `@<localpart>` mention tokens into the canonical
  // `@Name (senderRef)` form BEFORE length-check/storage, so the stored prompt
  // is what the outbound renderer can resolve back to a real mention. Skipped
  // for the clear/reset/`-` sentinels handled above. Best-effort — never throws.
  if (account) {
    try {
      newArgs = await rewritePromptMentions(account, chatId, newArgs, msg);
    } catch (err) {
      /* ignore — keep raw newArgs */
    }
  }

  if (newArgs.length > PROMPT_MAX_CHARS) {
    try {
      await sock.sendMessage(chatId, {
        text: `Prompt too long (${newArgs.length} chars). Maximum is ${PROMPT_MAX_CHARS} characters.`,
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  applyPrompt(newArgs);

  const preview =
    newArgs.length > 200 ? newArgs.slice(0, 197) + "..." : newArgs;
  try {
    await sock.sendMessage(chatId, {
      text: `Prompt updated${scopeSuffix(scope)}:\n${preview}`,
    });
  } catch (err) {
    /* ignore */
  }
}

export { handlePrompt, rewritePromptMentions };

export const promptCommand: CommandHandler = {
  commands: ["prompt", "prompts"],
  description: "Atur instruksi atau kepribadian bot khusus untuk chat ini (system prompt). Tanpa argumen menampilkan prompt saat ini. Gunakan /prompt clear untuk menghapus. Contoh: /prompt Jawab dengan singkat, sopan, dan dalam bahasa Indonesia.",
  permission: "isPrivate or isAdmin or isOwner",
  run: (_sock, _message, ctx) => handlePrompt(ctx),
};