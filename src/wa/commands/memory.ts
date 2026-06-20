// /memory — long-term memory the bot keeps about a chat.
//
// Subcommands:
//   /memory                       → list this chat's memories (+ global ones)
//   /memory add <text>            → save a fact/preference for this chat
//   /memory delete <index>        → delete the Nth memory (1-based, see /memory)
//   /memory global add <text>     → owner-only: add to the shared list ALL chats see
//   /memory global delete <index> → owner-only: delete from the shared list
//   (`default` is accepted as an alias of `global` for memory.)
//
// Usable by the bot itself (its run_command self-trigger), group admins, and the
// bot owner — NOT regular members. The LLM drives it via run_command (e.g.
// `/memory add Budi prefers Indonesian`); admins/owner can also manage it
// manually. Only the bot owner may touch the shared global list.
//
// Mentions (feature parity with /prompt + /schedule-task): a memory may tag a
// person. We store the STABLE LID behind each mention as the source of truth
// (in `memory_mentions`) and the canonical `@Name (senderRef)` projection in the
// memory text. The outbound renderer re-registers the senderRef->JID mapping
// from that LID with ZERO WhatsApp metadata refetch (see renderOutboundMentions),
// so mentions keep resolving after a restart / for silent users, and a display
// name change never breaks the tag (the senderRef is derived from the JID, not
// the name).
//
// Two input forms converge on the same stored shape:
//   1. Human types `/memory add ... @Budi ...` → the WhatsApp message carries
//      `contextInfo.mentionedJid`; rewritePromptMentions rewrites the raw
//      `@<localpart>` into `@Name (senderRef)`.
//   2. The LLM invokes `/memory add ... @Budi (abc123) ...` via run_command →
//      the text is already in `@Name (senderRef)` form (no contextInfo).
// Either way we then capture the senderRef->LID bindings from the final text.

import config from "../../config.js";
import * as registry from "../../server/accountRegistry.js";
import { parseConfigScope, scopeSuffix } from "./configScope.js";
import type { ConfigScope } from "./configScope.js";
import { rewritePromptMentions, renderStoredMentions } from "./prompt.js";
import { resolveMentionTargetBySenderRef } from "../domain/identifiers.js";
import { GLOBAL_CHAT_ID } from "../../db/schema/index.js";
import type { AccountContext } from "../../account/accountContext.js";
import type {
  CommandContext,
  CommandHandler,
} from "../command/CommandContext.js";

/** Max entries per scope, and max characters per entry. */
const MAX_MEMORIES = 50;
const MAX_MEMORY_CHARS = 500;

/** Match `@Name (value)` mention tokens — same grammar renderOutboundMentions uses. */
const MENTION_TOKEN = /@(.+?)\s*\(([^)\r\n]+)\)/g;
/** Non-person mention values handled specially by the renderer — never bound. */
const RESERVED_MENTION_VALUES = new Set(["all", "bot", "admin"]);

const USAGE =
  "🧠 *Long-term memory*\n\n" +
  "`/memory` — show saved memories\n" +
  "`/memory add <text>` — save a fact/preference for this chat\n" +
  "`/memory delete <index>` — remove the Nth memory (see `/memory`)\n\n" +
  "Owner-only, shared across all chats:\n" +
  "`/memory global add <text>` · `/memory global delete <index>`\n\n" +
  "Tip: tag people with the `@Name (senderRef)` format so they stay correctly " +
  "linked even if they change their display name.";

type Sock = CommandContext["sock"];

async function safeSend(
  sock: Sock,
  chatId: string,
  text: string,
): Promise<void> {
  try {
    await sock.sendMessage(chatId, { text });
  } catch {
    /* ignore send failures — never throw out of a command */
  }
}

/**
 * For a memory LIST, `global` and `default` both map to the shared `__global__`
 * store every chat sees (there is no "overwrite every chat" semantics for a
 * list), so the two scope tokens collapse to the same key.
 */
function scopeKeyFor(scope: ConfigScope, chatId: string): string {
  return scope === "chat" ? chatId : GLOBAL_CHAT_ID;
}

function previewText(text: string): string {
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

/**
 * Capture senderRef -> participant-JID (LID) bindings for every `@Name (ref)`
 * token in the final memory text. The senderRef registry was just populated
 * by rewritePromptMentions (human form) or by the live conversation (LLM form),
 * so this is a pure in-memory resolution — no WhatsApp call.
 */
function captureMentionBindings(
  account: AccountContext,
  chatId: string,
  text: string,
): Map<string, string> {
  const bindings = new Map<string, string>();
  for (const match of text.matchAll(MENTION_TOKEN)) {
    const value = (match[2] || "").trim().toLowerCase();
    if (!value || RESERVED_MENTION_VALUES.has(value)) continue;
    const jid = resolveMentionTargetBySenderRef(account, chatId, value);
    if (jid) bindings.set(value, jid);
  }
  return bindings;
}

function renderMemoryList(
  repos: NonNullable<CommandContext["repos"]>,
  chatId: string,
): string {
  const chatMems = repos.settings.listMemories(chatId);
  const globalMems =
    chatId === GLOBAL_CHAT_ID
      ? []
      : repos.settings.listMemories(GLOBAL_CHAT_ID);

  const lines: string[] = ["🧠 *Long-term memory*"];
  lines.push("");
  if (chatMems.length) {
    lines.push("*This chat:*");
    chatMems.forEach((m, i) =>
      lines.push(`${i + 1}. ${renderStoredMentions(repos.settings, chatId, m.text)}`),
    );
  } else {
    lines.push("_Nothing saved for this chat yet._");
  }
  if (globalMems.length) {
    lines.push("");
    lines.push("*Global (all chats):*");
    globalMems.forEach((m, i) =>
      lines.push(`${i + 1}. ${renderStoredMentions(repos.settings, chatId, m.text)}`),
    );
  }
  lines.push("");
  lines.push("Use `/memory add <text>` or `/memory delete <index>`.");
  return lines.join("\n");
}

export async function handleMemory(ctx: CommandContext): Promise<void> {
  const {
    chatId,
    senderIsOwner,
    args,
    folderPath = config.dataDir,
    sock,
    repos,
    account,
    msg,
  } = ctx;

  if (!repos) return; // no per-tenant store available — nothing we can do

  const raw = (args || "").trim();

  // 1) Optional leading scope token (global/default), owner-gated.
  let scope: ConfigScope = "chat";
  let work = raw;
  const scopeMatch = work.match(/^(global|default)\b\s*/i);
  if (scopeMatch) {
    scope = parseConfigScope(scopeMatch[1].toLowerCase());
    work = work.slice(scopeMatch[0].length);
  }
  const isScoped = scope !== "chat";
  if (isScoped && !senderIsOwner) {
    await safeSend(
      sock,
      chatId,
      "Only the bot owner can manage global/default memory.",
    );
    return;
  }
  const scopeKey = scopeKeyFor(scope, chatId);

  // 2) Subcommand.
  const subMatch = work.match(/^(add|delete|del|remove|rm|list)\b\s*/i);
  const sub = subMatch ? subMatch[1].toLowerCase() : "";
  if (subMatch) work = work.slice(subMatch[0].length);
  const rest = work.trim();

  const invalidate = (): void => {
    registry.sendReliableToClient(folderPath, {
      type: "invalidate_chat_settings",
      folderPath,
      chatId: isScoped ? "global" : chatId,
    });
  };

  // --- list (default when no subcommand) -----------------------------------
  if (!sub || sub === "list") {
    await safeSend(sock, chatId, renderMemoryList(repos, chatId));
    return;
  }

  // --- add -----------------------------------------------------------------
  if (sub === "add") {
    if (!rest) {
      await safeSend(
        sock,
        chatId,
        `Usage: \`/memory${isScoped ? " " + scope : ""} add <text>\``,
      );
      return;
    }

    // Rewrite raw `@<localpart>` mentions (human form) into `@Name (senderRef)`.
    // No-op for the LLM form (already `@Name (senderRef)`, no contextInfo).
    let text = rest;
    if (account) {
      try {
        text = await rewritePromptMentions(account, chatId, text, msg);
      } catch {
        text = rest;
      }
    }

    if (text.length > MAX_MEMORY_CHARS) {
      await safeSend(
        sock,
        chatId,
        `Memory too long (${text.length} chars). Maximum is ${MAX_MEMORY_CHARS} characters.`,
      );
      return;
    }

    const count = repos.settings.countMemories(scopeKey);
    if (count >= MAX_MEMORIES) {
      await safeSend(
        sock,
        chatId,
        `Memory is full (${MAX_MEMORIES} entries${scopeSuffix(scope)}). Delete some with \`/memory${isScoped ? " " + scope : ""} delete <index>\`.`,
      );
      return;
    }

    repos.settings.addMemory(scopeKey, text);
    // Persist the stable LID behind every mention so outbound rendering can
    // re-register it without a WhatsApp metadata refetch.
    if (account) {
      const bindings = captureMentionBindings(account, chatId, text);
      for (const [senderRef, lid] of bindings) {
        repos.settings.upsertMemoryMention(scopeKey, senderRef, lid);
      }
    }
    invalidate();

    await safeSend(
      sock,
      chatId,
      `🧠 Saved${scopeSuffix(scope)} (#${count + 1}):\n${previewText(renderStoredMentions(repos.settings, chatId, text))}`,
    );
    return;
  }

  // --- delete --------------------------------------------------------------
  if (sub === "delete" || sub === "del" || sub === "remove" || sub === "rm") {
    const index = Number.parseInt(rest, 10);
    if (!rest || !Number.isInteger(index) || index < 1) {
      await safeSend(
        sock,
        chatId,
        `Usage: \`/memory${isScoped ? " " + scope : ""} delete <index>\` — see \`/memory\` for the numbered list.`,
      );
      return;
    }
    const deleted = repos.settings.deleteMemoryByIndex(scopeKey, index);
    if (deleted === null) {
      await safeSend(
        sock,
        chatId,
        `No memory at index ${index}${scopeSuffix(scope)}. Use \`/memory\` to see the list.`,
      );
      return;
    }
    invalidate();
    await safeSend(
      sock,
      chatId,
      `🗑️ Deleted memory #${index}${scopeSuffix(scope)}:\n${previewText(renderStoredMentions(repos.settings, chatId, deleted))}`,
    );
    return;
  }

  // Unknown subcommand → usage.
  await safeSend(sock, chatId, USAGE);
}

export const memoryCommand: CommandHandler = {
  commands: ["memory", "memo"],
  description:
    "Save long-term memory the bot keeps about this chat. /memory lists saved entries, /memory add <text> saves one (mentions like @Name (senderRef) are kept stable), /memory delete <index> removes one. Owner-only /memory global add|delete manages a list shared across all chats.",
  // The bot itself (its run_command self-trigger sets fromMe), group admins, and
  // the bot owner — NOT regular members. The LLM manages memory automatically.
  permission: "fromMe or isAdmin or isOwner or isPrivate",
  run: (_sock, _message, ctx) => handleMemory(ctx),
};
