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
 *      - Cannot kick yourself (bot), admins, or super-admins
 *   4. Calls sock.groupParticipantsUpdate() with 'remove' action
 *
 * Returns per-target results with ok/error/detail fields.
 */
import {
  normalizeJid,
  resolveSenderByRef,
  resolveParticipantBySenderId,
} from './domain/identifiers.js';
import {
  roleFlagsForJid,
  normalizeKickTargets,
} from './domain/participants.js';
import {
  getGroupContext,
  currentBotAliases,
} from './domain/groupContext.js';
import { emitBotActionContextEvent } from './events.js';
import { actionError } from './actions.js';
import type { ActionResult, ErrorCode } from '../protocol/types.js';
import type { AccountContext } from '../account/accountContext.js';

/** A target that passed every validation gate and is ready for removal. */
interface ResolvedKickTarget {
  senderRef: string;
  senderId: string;
  participantJid: string;
}

/** Per-target outcome reported back to the bridge. */
interface KickResultItem {
  senderRef: string | null;
  ok: boolean;
  error: ErrorCode | null;
  detail: string;
}

function parseParticipantUpdateStatus(rawStatus: unknown): number {
  const status = Number(rawStatus);
  if (Number.isFinite(status)) return status;
  return 0;
}

async function kickMembers(ctx: AccountContext, {
  chatId,
  targets = [],
  mode = 'partial_success',
}: {
  chatId: string;
  targets?: unknown;
  mode?: 'partial_success' | 'all_or_nothing';
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
    const { senderRef } = target;
    if (!senderRef) {
      results.push({
        senderRef: senderRef || null,
        ok: false,
        error: 'invalid_target',
        detail: 'senderRef invalid',
      });
      continue;
    }

    const senderId = resolveSenderByRef(ctx, chatId, senderRef);
    if (!senderId) {
      results.push({
        senderRef,
        ok: false,
        error: 'invalid_target',
        detail: 'unknown senderRef',
      });
      continue;
    }

    const participantFromRegistry = resolveParticipantBySenderId(ctx, chatId, senderId);
    const participantJid = normalizeJid(participantFromRegistry) || normalizeJid(senderId) || senderId;
    if (!group.participantRoles?.[participantJid]) {
      results.push({
        senderRef,
        ok: false,
        error: 'invalid_target',
        detail: 'target is not an active group participant',
      });
      continue;
    }

    if (selfAliases.has(participantJid)) {
      results.push({
        senderRef,
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
        // Baileys types the participant-update result as `{ status, jid, content }`,
        // but the runtime nodes also carry `id`/`participant`/`user`/`code`. Read
        // through a loose view to preserve the original (untyped) field probing.
        const it = item as { status?: unknown; jid?: string; id?: string; participant?: string; user?: string; code?: unknown };
        const participantJid = normalizeJid(it?.jid || it?.id || it?.participant || it?.user);
        if (!participantJid) continue;
        statusByParticipant.set(participantJid, parseParticipantUpdateStatus(it?.status ?? it?.code));
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
        ok,
        error: ok ? null : 'send_failed',
        detail: ok ? 'removed' : `remove_failed_status_${status}`,
      });
    }

    if (successTargets.length > 0) {
      const kickedRefs = successTargets.map((item) => item.senderRef);
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
  kickMembers,
};
