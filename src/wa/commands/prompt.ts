import type { WAMessage } from "baileys";
import config from "../../config.js";
import * as registry from "../../server/accountRegistry.js";
import { parseConfigScope, scopeSuffix } from "./configScope.js";
import {
  normalizeJid,
  mentionHandleForJid,
  rememberSenderRef,
} from "../domain/identifiers.js";
import {
  unwrapMessage,
  extractMentionedJids,
} from "../domain/messageParser.js";
import { resolveParticipantLabel } from "../events.js";
import { escapeRegex } from "../utils.js";
import type { AccountContext } from "../../account/accountContext.js";
import type {
  CommandContext,
  CommandHandler,
} from "../command/CommandContext.js";

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
      const pattern = new RegExp(
        `${escapeRegex(handle)}(?![0-9A-Za-z._-])`,
        "g",
      );
      result = result.replace(pattern, `@${display} (${senderRef})`);
    } catch (err) {
      // best-effort: leave this token as-is and continue
    }
  }
  return result;
}

/** A stored mention token: `@<baked name> (<senderRef>)`; the senderRef is the
 * 6-char base-36 token derived from the JID (see makeSenderRef). */
const STORED_MENTION_RE = /@([^@()\r\n]+?)\s*\(([0-9a-z]{6})\)/g;

/** Minimal structural view of the settings repo this renderer needs. */
type ParticipantNameLookup = {
  getParticipantName(chatId: string, senderRef: string): string | null;
};

/**
 * Re-resolve the display name in each stored `@Name (senderRef)` mention to the
 * participant's CURRENT name, looked up by senderRef in the live roster the
 * gateway keeps fresh, while keeping the senderRef untouched. This is the Node
 * twin of the Python `render_stored_mentions` used for the LLM-facing surfaces,
 * so the command displays (`/memory` list, `/prompt` show) present the SAME live
 * names the model sees — a name unknown when the entry was saved (baked as the
 * bare number) resolves once that person has spoken, and renames track. A miss
 * leaves the token exactly as stored.
 */
function renderStoredMentions(
  settings: ParticipantNameLookup,
  chatId: string,
  text: string,
): string {
  if (!text || !chatId || !text.includes("(")) return text;
  return text.replace(STORED_MENTION_RE, (whole, _name: string, ref: string) => {
    const fresh = settings.getParticipantName(chatId, ref);
    return fresh ? `@${fresh} (${ref})` : whole;
  });
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
  // ponytail: inline join-prompt handling — YAGNI a separate function
  if (args) {
    const tok = args.trim().split(/\s+/)[0]?.toLowerCase();
    if (tok === "join") {
      if (!senderIsOwner) { try { await sock.sendMessage(chatId, { text: "Only bot owner can set the join prompt." }); } catch { /* ignore */ } return; }
      const val = args.trim().slice(4).trim(); // skip "join"
      if (!val || val === "join") { const c = repos!.settings.getBotConfig("join_prompt"); try { await sock.sendMessage(chatId, { text: c ? `Join prompt:\n${c}` : "No join prompt set." }); } catch { /* ignore */ } return; }
      if (["-", "clear", "reset"].includes(val.toLowerCase())) {
        repos!.settings.setBotConfig("join_prompt", null);
        registry.sendReliableToClient(folderPath, { type: "invalidate_chat_settings", folderPath, chatId: "global" });
        try { await sock.sendMessage(chatId, { text: "Join prompt cleared." }); } catch { /* ignore */ }
        return;
      }
      repos!.settings.setBotConfig("join_prompt", val);
      registry.sendReliableToClient(folderPath, { type: "invalidate_chat_settings", folderPath, chatId: "global" });
      try { await sock.sendMessage(chatId, { text: val.length > 200 ? `Join prompt updated:\n${val.slice(0, 197)}...` : `Join prompt updated:\n${val}` }); } catch { /* ignore */ }
      return;
    }
  }

  if (!args) {
    const current = repos!.settings.getPrompt(chatId);
    if (current) {
      const shown = renderStoredMentions(repos!.settings, chatId, current);
      try {
        await sock.sendMessage(chatId, { text: `Current prompt:\n${shown}` });
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
  let newArgs = isScoped
    ? args
        .trim()
        .replace(/^\S+\s*/, "")
        .trim()
    : args.trim();

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

export { handlePrompt, rewritePromptMentions, renderStoredMentions };

export const promptCommand: CommandHandler = {
  commands: ["prompt", "prompts"],
  description:
    "Set a custom instruction or personality for the bot in this chat (system prompt). Without arguments it shows the current prompt. Use /prompt clear to remove it. Example: /prompt Reply concisely, politely, and in English.\nUse `/prompt join <text>` (owner only) to set the message the bot uses when added to a group.",
  permission: "isPrivate or fromMe or isAdmin or isOwner",
  run: (_sock, _message, ctx) => handlePrompt(ctx),
};
