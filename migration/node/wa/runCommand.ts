/**
 * runCommand.js — Gateway-side handler for Python's `run_command` action.
 *
 * Lets LLM2 trigger a slash command via the optional `command` parameter on
 * `reply_message` *without* posting the command text to the WhatsApp chat.
 *
 * Flow:
 *   1. Python emits `{type: "run_command", payload: {chatId, command, contextMsgId?}}`.
 *   2. This module parses `command` with `parseSlashCommand`, builds the same
 *      context object that `connection.js` would build for a real human-typed
 *      slash command (chatType, sender flags, group metadata, msg with quoted
 *      stanza when `contextMsgId` is provided), and invokes
 *      `handleCommandListener` directly.
 *   3. The result is reported back via `action_ack`, including the canonical
 *      command name so Python can append a clean log entry to LLM history.
 *
 * The synthesised `msg` is treated as if the bot itself typed the command
 * (`fromMe: true`, sender = bot's own JID), which mirrors how a genuine
 * self-trigger would have looked under the old two-reply protocol.
 */
import logger from '../logger.js';
import { parseSlashCommand } from './command/index.js';
import { handleCommandListener } from './commandHandler.js';
import { roleFlagsForJid } from '../participants.js';
import {
  getCachedGroupMetadata,
  defaultGroupContext,
  getGroupContext,
  currentBotAliases,
} from '../groupContext.js';
import {
  normalizeJid,
  resolveQuotedMessage,
  getIndexedMessageByContextId,
  normalizeContextMsgId,
} from '../identifiers.js';
import type { GroupContextValue, ParticipantRoleFlags } from '../caches.js';
import type { RunCommandPayload } from '../protocol/types.js';
import type { AccountContext } from '../account/accountContext.js';

/**
 * Build a fake `msg` object that command handlers can treat like any other
 * incoming WA message. When `contextMsgId` resolves to a cached message we
 * embed it as a quoted reply so handlers like `/sticker` and `/catch` can
 * pull the media via `extendedTextMessage.contextInfo.{stanzaId,quotedMessage}`.
 */
function buildFakeMessage({
  ctx,
  chatId,
  commandText,
  senderId,
  fromMe,
  contextMsgId,
}: {
  ctx: AccountContext;
  chatId: string;
  commandText: string;
  senderId: string;
  fromMe: boolean;
  contextMsgId: string | null;
}) {
  let messageBody: Record<string, unknown> | undefined;
  let stanzaId: string | null = null;
  if (contextMsgId) {
    const quoted = resolveQuotedMessage(ctx, chatId, contextMsgId);
    const indexed = getIndexedMessageByContextId(ctx, chatId, contextMsgId);
    stanzaId = indexed?.id || null;
    if (quoted && stanzaId) {
      messageBody = {
        extendedTextMessage: {
          text: commandText,
          contextInfo: {
            stanzaId,
            participant: indexed?.participant || indexed?.senderId || undefined,
            quotedMessage: quoted.message || { conversation: '' },
          },
        },
      };
    }
  }
  if (!messageBody) {
    messageBody = { conversation: commandText };
  }

  // When we have a resolved stanzaId from the quoted context, reuse it as the
  // fake message's id. This is what makes `replyTo: msg.key.id` resolvable in
  // downstream handlers like /sticker — the synthetic `runcmd_xxx` id is
  // never registered in the message cache, so `sendOutgoing` would otherwise
  // throw "reply target not found". Using the real stanzaId means the bot
  // ends up quoting the original media (which is the natural target anyway).
  // When there's no quoted context, fall back to a synthetic id; handlers
  // that don't need replyTo (e.g. /help, /dashboard) still work.
  const fakeKey = {
    id: stanzaId || `runcmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    remoteJid: chatId,
    fromMe,
    participant: senderId || undefined,
  };

  return {
    key: fakeKey,
    message: messageBody,
    pushName: 'Bot',
    quotedStanzaId: stanzaId,
  };
}

/**
 * Resolve the bot's own JID for impersonation. Falls back to a generic
 * `bot@s.whatsapp.net` placeholder if the socket isn't fully ready — command
 * handlers only use this for permission checks and `senderIsOwner`, both of
 * which are explicitly forced to true below since the bot is privileged.
 */
function resolveBotSenderId(ctx: AccountContext): string {
  const sock = ctx.sock;
  const rawId = sock?.user?.id || sock?.user?.jid || null;
  return normalizeJid(rawId) || rawId || 'bot@s.whatsapp.net';
}

async function buildGroupSnapshot(ctx: AccountContext, chatId: string): Promise<GroupContextValue | null> {
  if (!chatId.endsWith('@g.us')) return null;
  // Prefer the cached snapshot to avoid blocking on `groupMetadata`. Fall
  // back to a fresh lookup when the cache is cold.
  const cached = getCachedGroupMetadata(ctx, chatId);
  if (cached) return cached;
  try {
    return await getGroupContext(ctx, chatId);
  } catch (err) {
    logger.warn({ err, chatId }, 'run_command: group lookup failed, using default context');
    return defaultGroupContext(chatId);
  }
}

/**
 * Dispatch a `run_command` payload arriving from the Python bridge.
 *
 * @returns Result for the `action_ack`.
 */
async function dispatchRunCommand(
  ctx: AccountContext,
  payload: Partial<RunCommandPayload> | null | undefined,
): Promise<{ ok: boolean; command: string | null; detail: string }> {
  const chatId = payload?.chatId;
  const rawCommand = payload?.command;
  const contextMsgId = normalizeContextMsgId(payload?.contextMsgId);

  if (!chatId || typeof chatId !== 'string') {
    return { ok: false, command: null, detail: 'missing chatId' };
  }
  if (!rawCommand || typeof rawCommand !== 'string') {
    return { ok: false, command: null, detail: 'missing command text' };
  }

  const slashCommand = parseSlashCommand(rawCommand);
  if (!slashCommand) {
    return { ok: false, command: null, detail: `unrecognised command: ${rawCommand}` };
  }

  const isGroup = chatId.endsWith('@g.us');
  const chatType = isGroup ? 'group' : 'private';
  const group = await buildGroupSnapshot(ctx, chatId);
  const botSenderId = resolveBotSenderId(ctx);
  const botAliases = currentBotAliases(ctx);

  // Compute admin/super-admin flags from the bot's own role in the group.
  // The bot acts as the impersonated sender, so `senderIsAdmin` mirrors
  // `botIsAdmin` and friends — this is what unlocks group-only commands
  // like `/group-status`.
  let senderIsAdmin = false;
  let senderRole: ParticipantRoleFlags = { isAdmin: false, isSuperAdmin: false };
  if (isGroup && group?.participantRoles) {
    for (const alias of botAliases.length ? botAliases : [botSenderId]) {
      const flags = roleFlagsForJid(group.participantRoles, alias);
      if (flags.isAdmin || flags.isSuperAdmin) {
        senderIsAdmin = true;
        senderRole = flags;
        break;
      }
    }
  }

  const fakeMsg = buildFakeMessage({
    ctx,
    chatId,
    commandText: rawCommand,
    senderId: botSenderId,
    fromMe: true,
    contextMsgId,
  });

  const context = {
    slashCommand,
    chatId,
    chatType,
    senderId: botSenderId,
    senderIsAdmin,
    // The bot is privileged by definition for self-triggered commands.
    // Without this owner-only commands like `/owner-contact`, `/subagent`,
    // and `/idle` would refuse to run.
    senderIsOwner: true,
    senderRole,
    senderDisplay: 'Bot',
    botIsAdmin: Boolean(group?.botIsAdmin),
    botIsSuperAdmin: Boolean(group?.botIsSuperAdmin),
    contextMsgId: fakeMsg.quotedStanzaId,
    fromMe: true,
    text: rawCommand,
    group,
    msg: fakeMsg,
    account: ctx,
    sock: ctx.sock,
  };

  logger.info(
    { chatId, command: slashCommand.command, args: slashCommand.args, contextMsgId },
    'run_command: dispatching self-triggered slash command',
  );

  await handleCommandListener(fakeMsg, context);

  return {
    ok: true,
    command: slashCommand.command,
    detail: 'executed',
  };
}

export { dispatchRunCommand };
