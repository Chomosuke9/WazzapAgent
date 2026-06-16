import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeGroupJoinEvent } from '../../src/wa/domain/groupContext.ts';

// Minimal ctx: dedupeGroupJoinEvent only touches `groupJoinDedupCache`.
function makeCtx(): any {
  return { groupJoinDedupCache: new Map<string, number>() };
}

const CHAT = '12345@g.us';

test('group join dedup collapses the same join reported by both sources with different JID forms (LID vs phone)', () => {
  const ctx = makeCtx();
  const t0 = 1_000_000;

  // Source 1: messages.upsert system stub reports the joiner as a phone JID.
  const first = dedupeGroupJoinEvent(ctx, CHAT, ['628123456789@s.whatsapp.net'], 'add', t0);
  assert.equal(first, true, 'first emit of the join should pass');

  // Source 2: group-participants.update reports the SAME joiner as a LID, ~1s later.
  const second = dedupeGroupJoinEvent(ctx, CHAT, ['111122223333@lid'], 'add', t0 + 1_000);
  assert.equal(second, false, 'cross-source duplicate (different JID form) must be deduped');
});

test('group join dedup still collapses exact same-source replays within the full TTL', () => {
  const ctx = makeCtx();
  const t0 = 2_000_000;
  assert.equal(dedupeGroupJoinEvent(ctx, CHAT, ['628111@s.whatsapp.net'], 'add', t0), true);
  // History-sync replay ~10s later (beyond the short cross-source window, within the 15s exact TTL).
  assert.equal(
    dedupeGroupJoinEvent(ctx, CHAT, ['628111@s.whatsapp.net'], 'add', t0 + 10_000),
    false,
    'exact same-source replay within 15s must be deduped',
  );
});

test('group join dedup lets genuinely distinct joins through once outside the coalescing window', () => {
  const ctx = makeCtx();
  const t0 = 3_000_000;
  assert.equal(dedupeGroupJoinEvent(ctx, CHAT, ['628aaa@s.whatsapp.net'], 'add', t0), true);
  // A different person joining well after the 5s cross-source window must still trigger.
  assert.equal(
    dedupeGroupJoinEvent(ctx, CHAT, ['628bbb@s.whatsapp.net'], 'add', t0 + 6_000),
    true,
    'a distinct join after the coalescing window should not be suppressed',
  );
});

test('group join dedup keys are per-chat', () => {
  const ctx = makeCtx();
  const t0 = 4_000_000;
  assert.equal(dedupeGroupJoinEvent(ctx, CHAT, ['628xyz@s.whatsapp.net'], 'add', t0), true);
  assert.equal(
    dedupeGroupJoinEvent(ctx, '99999@g.us', ['628xyz@s.whatsapp.net'], 'add', t0 + 500),
    true,
    'same join signature in a different chat must not be deduped',
  );
});
