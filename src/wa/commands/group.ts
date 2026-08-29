import logger from "../../logger.js";
import * as registry from "../../server/accountRegistry.js";
import type { CommandContext, CommandHandler } from "../command/CommandContext.js";
import { rewritePromptMentions } from "./prompt.js";
import { resolveQuotedMessage } from "../domain/identifiers.js";
import { kickMembers } from "../moderation.js";

const TARGET_RE = /^@(.+?)\s*\(([0-9a-z]{6})\)$/i;
const MUTE_RE = /^@(.+?)\s*\(([0-9a-z]{6})\)\s+(\d+)$/i;
const PIN_SECONDS: Record<string, 86400 | 604800 | 2592000> = {
  "1": 86400,
  "7": 604800,
  "30": 2592000,
};

const BOT_PERMISSION_REQUIRED = {
  delete: 1,
  mute: 2,
  kick: 3,
} as const;

const USAGE = [
  "🛠️ *Group management*",
  "",
  "`/group close` — only admins may send messages",
  "`/group open` — all members may send messages",
  "`/group pin <1|7|30>` — reply to the message to pin",
  "`/group delete` — reply to the message to delete",
  "`/group description <text>` — change the group description",
  "`/group kick @mention` — remove a member",
  "`/group mute @mention <minutes>` — mute; use 0 to unmute",
].join("\n");

async function safeText(ctx: CommandContext, text: string): Promise<void> {
  try {
    await ctx.sock.sendMessage(ctx.chatId, { text });
  } catch (err) {
    logger.warn({ err, chatId: ctx.chatId }, "failed sending /group response");
  }
}

async function canonicalArgs(ctx: CommandContext, raw: string): Promise<string> {
  if (!ctx.account) return raw;
  try {
    return await rewritePromptMentions(ctx.account, ctx.chatId, raw, ctx.msg);
  } catch {
    return raw;
  }
}

function repliedMessage(ctx: CommandContext) {
  if (!ctx.account || !ctx.quotedMessageId) return null;
  return resolveQuotedMessage(ctx.account, ctx.chatId, ctx.quotedMessageId);
}

function getQuotedMessageType(ctx: CommandContext): string | null {
  const contextInfo = (ctx.msg.message?.extendedTextMessage?.contextInfo ||
    ctx.msg.message?.textMessage?.contextInfo ||
    ctx.msg.message?.imageMessage?.contextInfo ||
    ctx.msg.message?.videoMessage?.contextInfo ||
    ctx.msg.message?.documentMessage?.contextInfo ||
    ctx.msg.message?.audioMessage?.contextInfo ||
    ctx.msg.message?.stickerMessage?.contextInfo) as any;
  
  if (!contextInfo?.quotedMessage) return null;
  
  const quotedMsg = contextInfo.quotedMessage as any;
  if (quotedMsg.groupStatusMessageV2) return "groupStatusMessageV2";
  if (quotedMsg.viewOnceMessage) return "viewOnceMessage";
  if (quotedMsg.ephemeralMessage) return "ephemeralMessage";
  
  return null;
}

function botPermissionLevel(ctx: CommandContext): number {
  if (!ctx.fromMe) return 3;
  try {
    const level = Number(ctx.repos?.settings.getPermission(ctx.chatId) ?? 0);
    return Number.isFinite(level) ? Math.max(0, Math.min(3, Math.trunc(level))) : 0;
  } catch {
    return 0;
  }
}

async function requireBotModerationPermission(
  ctx: CommandContext,
  action: keyof typeof BOT_PERMISSION_REQUIRED,
): Promise<boolean> {
  if (!ctx.fromMe) return true;
  const current = botPermissionLevel(ctx);
  const required = BOT_PERMISSION_REQUIRED[action];
  if (current >= required) return true;
  await safeText(
    ctx,
    `Bot permission ${current} cannot ${action}; permission ${required} is required. ❌`,
  );
  return false;
}

export async function handleGroup(ctx: CommandContext): Promise<void> {
  const raw = (ctx.args || "").trim();
  const splitAt = raw.search(/\s/);
  const sub = (splitAt === -1 ? raw : raw.slice(0, splitAt)).toLowerCase();
  const restRaw = splitAt === -1 ? "" : raw.slice(splitAt + 1).trim();

  const botAdminOnlyCommands = new Set(["close", "open", "pin", "description"]);
  const adminOrBotCommands = new Set(["delete", "kick", "mute"]);

  if (botAdminOnlyCommands.has(sub) && !ctx.botIsAdmin) {
    await safeText(ctx, "The bot must be a group admin to use this command. ❌");
    return;
  }

  if (adminOrBotCommands.has(sub) && !ctx.botIsAdmin && !ctx.senderIsAdmin) {
    await safeText(ctx, "You must be a group admin (or the bot must be an admin) to use this command. ❌");
    return;
  }

  try {
    if (sub === "close" || sub === "open") {
      await ctx.sock.groupSettingUpdate(
        ctx.chatId,
        sub === "close" ? "announcement" : "not_announcement",
      );
      return;
    }

    if (sub === "description") {
      if (!restRaw) {
        await safeText(ctx, "Usage: `/group description <text>`");
        return;
      }
      await ctx.sock.groupUpdateDescription(ctx.chatId, restRaw);
      return;
    }

    if (sub === "pin") {
      const seconds = PIN_SECONDS[restRaw];
      const target = repliedMessage(ctx);
      if (!seconds || !target?.key) {
        await safeText(ctx, "Reply to a message, then use `/group pin <1|7|30>`.");
        return;
      }
      await ctx.sock.sendMessage(ctx.chatId, {
        pin: target.key,
        type: 1,
        time: seconds,
      });
      return;
    }

    if (sub === "delete") {
      if (!await requireBotModerationPermission(ctx, "delete")) return;
      const quotedType = getQuotedMessageType(ctx);
      if (quotedType === "groupStatusMessageV2") {
        await safeText(ctx, "Cannot delete status updates. Only regular messages can be deleted.");
        return;
      }
      if (quotedType === "viewOnceMessage") {
        await safeText(ctx, "Cannot delete view-once messages.");
        return;
      }
      if (quotedType === "ephemeralMessage") {
        await safeText(ctx, "Cannot delete disappearing messages.");
        return;
      }
      const target = repliedMessage(ctx);
      if (!target?.key) {
        await safeText(ctx, "Reply to the message you want to delete, then use `/group delete`.");
        return;
      }
      await ctx.sock.sendMessage(ctx.chatId, { delete: target.key });
      return;
    }

    if (sub === "kick") {
      if (!await requireBotModerationPermission(ctx, "kick")) return;
      const canonical = await canonicalArgs(ctx, restRaw);
      const target = canonical.match(TARGET_RE);
      if (!target || !ctx.account) {
        await safeText(ctx, "Usage: `/group kick @mention`");
        return;
      }
      const result = await kickMembers(ctx.account, {
        chatId: ctx.chatId,
        targets: [{ senderRef: target[2].toLowerCase() }],
        mode: "all_or_nothing",
      }) as { results?: Array<{ ok?: boolean; detail?: string }> };
      const outcome = result.results?.[0];
      if (!outcome?.ok) {
        logger.warn(
          { chatId: ctx.chatId, senderRef: target[2].toLowerCase(), detail: outcome?.detail },
          "/group kick failed",
        );
      }
      return;
    }

    if (sub === "mute") {
      if (!await requireBotModerationPermission(ctx, "mute")) return;
      const canonical = await canonicalArgs(ctx, restRaw);
      const target = canonical.match(MUTE_RE);
      if (!target) {
        await safeText(ctx, "Usage: `/group mute @mention <minutes>`; use 0 to unmute.");
        return;
      }
      const durationMinutes = Number(target[3]);
      if (!Number.isSafeInteger(durationMinutes) || durationMinutes < 0 || durationMinutes > 43200) {
        await safeText(ctx, "Mute duration must be between 0 and 43200 minutes.");
        return;
      }
      registry.sendReliableToClient(ctx.folderPath, {
        type: "set_chat_mute",
        folderPath: ctx.folderPath,
        chatId: ctx.chatId,
        senderRef: target[2].toLowerCase(),
        senderName: target[1].trim() || null,
        durationMinutes,
      });
      await safeText(
        ctx,
        durationMinutes === 0
          ? `🔊 @${target[1]} was unmuted.`
          : `🔇 @${target[1]} was muted for ${durationMinutes} minute(s).`,
      );
      return;
    }
  } catch (err) {
    logger.warn({ err, chatId: ctx.chatId, subcommand: sub }, "/group command failed");
    await safeText(ctx, "Group action failed. Please try again. ❌");
    return;
  }

  await safeText(ctx, USAGE);
}

export const groupCommand: CommandHandler = {
  commands: ["group", "g"],
  description:
    "Manage the current group: close/open, pin/delete a replied message, change description, kick, or mute members.",
  permission: "group and (admin or from_me)",
  run: (_sock, _message, ctx) => handleGroup(ctx),
};
