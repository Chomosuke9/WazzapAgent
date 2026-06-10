/**
 * moderation.js — Kick members from WhatsApp groups.
 *
 * Handles the `kick_member` action from the Python bridge.
 *
 * Validation chain:
 *   1. Must be a group chat (not DM)
 *   2. Bot must be admin in the group
 *   3. Each target is validated:
 *      - senderRef must resolve to a known participant
 *      - anchorContextMsgId must belong to the same senderRef
 *      - Cannot kick yourself (bot), admins, or super-admins
 *   4. Calls sock.groupParticipantsUpdate() with 'remove' action
 *
 * Returns per-target results with ok/error/detail fields.
 * If `autoReplyAnchor=true`, posts a confirmation message replying to the
 * anchor message for each successfully kicked target.
 */
import logger from '../logger.js';
import {
  normalizeJid,
  nextContextMsgId,
  rememberSenderRef,
  rememberMessage,
  resolveQuotedMessage,
  getIndexedMessageByContextId,
  resolveSenderByRef,
  resolveParticipantBySenderId,
} from '../identifiers.js';
import {
  roleFlagsForJid,
  normalizeKickTargets,
} from '../participants.js';
import {
  getGroupContext,
  currentBotAliases,
} from '../groupContext.js';
import { emitBotActionContextEvent } from './events.js';
import { actionError } from './actions.js';
import type { ActionResult, ErrorCode } from '../protocol/types.js';
import type { AccountContext } from '../account/accountContext.js';

/** A target that passed every validation gate and is ready for removal. */
interface ResolvedKickTarget {
  senderRef: string;
  senderId: string;
  participantJid: string;
  anchorContextMsgId: string;
}

/** Per-target outcome reported back to the bridge. */
interface KickResultItem {
  senderRef: string | null;
  anchorContextMsgId: string | null;
  ok: boolean;
  error: ErrorCode | null;
  detail: string;
}

function parseParticipantUpdateStatus(rawStatus: unknown): number {
  const status = Number(rawStatus);
  if (Number.isFinite(status)) return status;
  return 0;
}

async function maybeEmitKickAnchorReplies(
  ctx: AccountContext,
  chatId: string,
  successTargets: ResolvedKickTarget[],
): Promise<void> {
  const sock = ctx.sock;
  if (!Array.isArray(successTargets) || successTargets.length === 0) return;
  const botSenderId = normalizeJid(sock?.user?.id) || 'bot@wazzap.local';
  const botSenderRef = rememberSenderRef(ctx, chatId, botSenderId, botSenderId) || 'unknown';
  const group = chatId.endsWith('@g.us') ? await getGroupContext(ctx, chatId) : null;

  for (const target of successTargets) {
    const quoted = resolveQuotedMessage(ctx, chatId, target.anchorContextMsgId);
    const text = `Moderation: removed ${target.senderRef}.`;
    try {
      const sent = await sock.sendMessage(chatId, { text }, quoted ? { quoted } : {});
      const contextMsgId = nextContextMsgId(ctx, chatId);
      rememberMessage(ctx, sent, {
        chatId,
        contextMsgId,
        senderId: botSenderId,
        senderRef: botSenderRef,
        senderIsAdmin: Boolean(group?.botIsAdmin),
        fromMe: true,
        timestampMs: Date.now(),
      });
    } catch (err) {
      logger.warn({ err, chatId, target }, 'failed sending autoReplyAnchor log');
    }
  }
}

async function kickMembers(ctx: AccountContext, {
  chatId,
  targets = [],
  mode = 'partial_success',
  autoReplyAnchor = false,
}: {
  chatId: string;
  targets?: unknown;
  mode?: 'partial_success' | 'all_or_nothing';
  autoReplyAnchor?: boolean;
}): Promise<ActionResult> {
  const sock = ctx.sock;
  if (!sock) throw actionError('send_failed', 'WhatsApp socket not ready');
  if (!chatId || !chatId.endsWith('@g.us')) {
    throw actionError('not_group', 'kick_member can only run in group chats');
  }

  const group = await getGroupContext(ctx, chatId, { forceRefresh: true });
  if (!group?.botIsAdmin) {
    throw actionError('permission_denied', 'bot is not admin');
  }

  const selfAliases = new Set(currentBotAliases(ctx));
  const normalizedTargets = normalizeKickTargets(targets);
  const resolvedTargets: ResolvedKickTarget[] = [];
  const results: KickResultItem[] = [];

  for (const target of normalizedTargets) {
    const { senderRef, anchorContextMsgId } = target;
    if (!senderRef || !anchorContextMsgId) {
      results.push({
        senderRef: senderRef || null,
        anchorContextMsgId: anchorContextMsgId || null,
        ok: false,
        error: 'invalid_target',
        detail: 'senderRef or anchorContextMsgId invalid',
      });
      continue;
    }

    const senderId = resolveSenderByRef(ctx, chatId, senderRef);
    if (!senderId) {
      results.push({
        senderRef,
        anchorContextMsgId,
        ok: false,
        error: 'invalid_target',
        detail: 'unknown senderRef',
      });
      continue;
    }

    const anchor = getIndexedMessageByContextId(ctx, chatId, anchorContextMsgId);
    if (!anchor) {
      results.push({
        senderRef,
        anchorContextMsgId,
        ok: false,
        error: 'not_found',
        detail: 'anchor message not found',
      });
      continue;
    }
    if ((anchor.senderRef || '').toLowerCase() !== senderRef) {
      results.push({
        senderRef,
        anchorContextMsgId,
        ok: false,
        error: 'invalid_target',
        detail: 'anchor does not belong to senderRef',
      });
      continue;
    }

    const participantFromRegistry = resolveParticipantBySenderId(ctx, chatId, senderId);
    const participantJid = normalizeJid(participantFromRegistry) || normalizeJid(senderId) || senderId;
    if (!group.participantRoles?.[participantJid]) {
      results.push({
        senderRef,
        anchorContextMsgId,
        ok: false,
        error: 'invalid_target',
        detail: 'target is not an active group participant',
      });
      continue;
    }

    if (selfAliases.has(participantJid)) {
      results.push({
        senderRef,
        anchorContextMsgId,
        ok: false,
        error: 'invalid_target',
        detail: 'cannot kick bot/self',
      });
      continue;
    }

    const targetRole = roleFlagsForJid(group.participantRoles, participantJid);
    if (targetRole.isAdmin || targetRole.isSuperAdmin) {
      results.push({
        senderRef,
        anchorContextMsgId,
        ok: false,
        error: 'permission_denied',
        detail: 'cannot kick admin/superadmin',
      });
      continue;
    }

    resolvedTargets.push({
      senderRef,
      senderId: normalizeJid(senderId) || senderId,
      participantJid,
      anchorContextMsgId,
    });
  }

  const uniqueResolved: ResolvedKickTarget[] = [];
  const seenParticipant = new Set<string>();
  for (const target of resolvedTargets) {
    if (seenParticipant.has(target.participantJid)) continue;
    seenParticipant.add(target.participantJid);
    uniqueResolved.push(target);
  }

  if (uniqueResolved.length > 0) {
    let updateResponse;
    try {
      updateResponse = await sock.groupParticipantsUpdate(
        chatId,
        uniqueResolved.map((item) => item.participantJid),
        'remove'
      );
    } catch (err) {
      for (const target of uniqueResolved) {
        results.push({
          senderRef: target.senderRef,
          anchorContextMsgId: target.anchorContextMsgId,
          ok: false,
          error: 'send_failed',
          detail: (err as { message?: string })?.message || 'failed to execute kick',
        });
      }
      return { ok: false, mode, results } as ActionResult;
    }

    const statusByParticipant = new Map<string, number>();
    if (Array.isArray(updateResponse)) {
      for (const item of updateResponse) {
        const participantJid = normalizeJid(item?.jid || item?.id || item?.participant || item?.user);
        if (!participantJid) continue;
        statusByParticipant.set(participantJid, parseParticipantUpdateStatus(item?.status ?? item?.code));
      }
    }

    const successTargets: ResolvedKickTarget[] = [];
    for (const target of uniqueResolved) {
      const status = statusByParticipant.has(target.participantJid)
        ? statusByParticipant.get(target.participantJid)!
        : 200;
      const ok = status >= 200 && status < 300;
      if (ok) {
        successTargets.push(target);
      }
      results.push({
        senderRef: target.senderRef,
        anchorContextMsgId: target.anchorContextMsgId,
        ok,
        error: ok ? null : 'send_failed',
        detail: ok ? 'removed' : `remove_failed_status_${status}`,
      });
    }

    if (autoReplyAnchor && successTargets.length > 0) {
      await maybeEmitKickAnchorReplies(ctx, chatId, successTargets);
    }
    if (successTargets.length > 0) {
      const kickedRefs = successTargets.map(
        (item) => `${item.senderRef}@${item.anchorContextMsgId}`
      );
      const text = kickedRefs.length === 1
        ? `Action log: kicked ${kickedRefs[0]}.`
        : `Action log: kicked ${kickedRefs.length} members (${kickedRefs.join(', ')}).`;
      emitBotActionContextEvent(ctx, {
        chatId,
        action: 'kick_member',
        text,
        result: {
          mode,
          targets: successTargets.map((item) => ({
            senderRef: item.senderRef,
            anchorContextMsgId: item.anchorContextMsgId,
            participantJid: item.participantJid,
          })),
        },
      });
    }
  }

  return {
    ok: results.some((item) => item.ok),
    mode,
    results,
  } as ActionResult;
}

export {
  parseParticipantUpdateStatus,
  maybeEmitKickAnchorReplies,
  kickMembers,
};
