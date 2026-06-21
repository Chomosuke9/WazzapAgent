// group-metadata-stampede.test.ts — regression for the group-metadata fetch
// stampede that produced the `rate-overlimit` log storm.
//
// Repro from production: a burst of messages for the SAME group with a cold
// cache made every message fire its own `sock.groupMetadata` call, and a
// failed fetch was never cached — so each subsequent message immediately
// re-fired a doomed query, both spamming the logs and deepening WhatsApp's
// rate limit (group-metadata refetch is ban-risky — see AGENTS.md).
//
// Covers:
//   * In-flight dedup: N concurrent callers for one group share ONE fetch.
//   * Negative caching / backoff: a `rate-overlimit` failure suppresses the
//     immediate re-fetch (and forceRefresh too), then retries after cooldown.
//   * Graceful degradation: a failing refresh serves the stale cached snapshot
//     instead of a bare default.
//
// Env MUST be set before importing config (it reads env at import time).
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wazzap-gm-stampede-'));
process.env.LOG_LEVEL = 'silent';
process.env.REQUIRE_ACTIVATION = 'false';

import test from 'node:test';
import assert from 'node:assert/strict';

const { getGroupContext, getGroupParticipantName } = await import('../../src/wa/domain/groupContext.ts');
const { rememberParticipantName } = await import('../../src/wa/domain/participants.ts');
const { createAccountContext } = await import('../../src/account/accountContext.ts');

test('coalesces concurrent fetches for the same group into a single groupMetadata call', async () => {
  const ctx = createAccountContext('/tenants/gm-stampede');
  const chatId = '120363408061498041@g.us';

  // Hold the fetch open so all callers pile up on the SAME in-flight promise.
  let releaseFetch = () => {};
  const fetchGate = new Promise<void>((resolve) => { releaseFetch = resolve; });
  let callCount = 0;
  ctx.sock = {
    user: { id: 'bot@s.whatsapp.net' },
    groupMetadata: async (jid: string) => {
      callCount += 1;
      await fetchGate;
      return { id: jid, subject: 'Group A', participants: [] };
    },
  } as never;

  // Simulate a burst: six messages for the same group, cold cache, all at once.
  const pending = Array.from({ length: 6 }, () => getGroupContext(ctx, chatId));
  releaseFetch();
  const results = await Promise.all(pending);

  assert.equal(callCount, 1, 'six concurrent callers must share ONE groupMetadata fetch');
  for (const r of results) assert.equal(r.name, 'Group A');
  // The in-flight entry is cleaned up once settled.
  assert.equal(ctx.groupMetadataInflight.has(chatId), false);
});

test('backs off after a rate-overlimit failure, then retries after the cooldown clears', async () => {
  const ctx = createAccountContext('/tenants/gm-cooldown');
  const chatId = '120363408061498041@g.us';
  let callCount = 0;
  let mode: 'fail' | 'ok' = 'fail';
  ctx.sock = {
    user: { id: 'bot@s.whatsapp.net' },
    groupMetadata: async (jid: string) => {
      callCount += 1;
      if (mode === 'fail') throw new Error('rate-overlimit');
      return { id: jid, subject: 'Recovered', participants: [] };
    },
  } as never;

  // 1) First fetch fails → returns default + arms the cooldown.
  const first = await getGroupContext(ctx, chatId);
  assert.equal(callCount, 1);
  assert.equal(first.name, chatId, 'failed cold fetch falls back to default');
  assert.ok(ctx.groupMetadataCooldownUntil.has(chatId), 'a failure arms the cooldown');

  // 2) Immediate retry is SUPPRESSED — this is the storm being broken.
  await getGroupContext(ctx, chatId);
  assert.equal(callCount, 1, 'no re-fetch while cooling down');

  // 2b) forceRefresh is ALSO suppressed during cooldown (ban-safety).
  await getGroupContext(ctx, chatId, { forceRefresh: true });
  assert.equal(callCount, 1, 'forceRefresh also respects the cooldown');

  // 3) Cooldown expires + endpoint recovers → next call fetches and clears it.
  ctx.groupMetadataCooldownUntil.set(chatId, Date.now() - 1);
  mode = 'ok';
  const recovered = await getGroupContext(ctx, chatId);
  assert.equal(callCount, 2, 'fetch retried once the cooldown expired');
  assert.equal(recovered.name, 'Recovered');
  assert.equal(ctx.groupMetadataCooldownUntil.has(chatId), false, 'success clears the cooldown');
});

test('serves the stale cached snapshot (not default) when a refresh fails', async () => {
  const ctx = createAccountContext('/tenants/gm-stale');
  const chatId = '120363408061498041@g.us';
  let mode: 'ok' | 'fail' = 'ok';
  ctx.sock = {
    user: { id: 'bot@s.whatsapp.net' },
    groupMetadata: async (jid: string) => {
      if (mode === 'fail') throw new Error('rate-overlimit');
      return { id: jid, subject: 'Cached Name', participants: [] };
    },
  } as never;

  // Prime the cache with a successful fetch.
  const ok = await getGroupContext(ctx, chatId);
  assert.equal(ok.name, 'Cached Name');

  // A forced refresh now fails — must serve the still-cached snapshot, NOT default.
  mode = 'fail';
  const stale = await getGroupContext(ctx, chatId, { forceRefresh: true });
  assert.equal(stale.name, 'Cached Name', 'stale cache served on failure instead of a bare default');
  assert.ok(ctx.groupMetadataCooldownUntil.has(chatId), 'the failed refresh armed a cooldown');
});

// --------------------------------------------------------------------------- //
// getGroupParticipantName: negative caching of unresolvable names.
// Before the fix, every message referencing an unnameable @lid sender forced a
// fresh groupMetadata refetch (the second, forceRefresh call) — a primary
// trigger of the rate-overlimit storm.
// --------------------------------------------------------------------------- //

test('negative-caches an unresolvable participant name instead of forcing a refetch every call', async () => {
  const ctx = createAccountContext('/tenants/gpn-neg');
  const chatId = '120363408061498041@g.us';
  const ghost = '90727660945596@lid'; // never present in metadata, no pushName
  let callCount = 0;
  ctx.sock = {
    user: { id: 'bot@s.whatsapp.net' },
    groupMetadata: async (jid: string) => {
      callCount += 1;
      return { id: jid, subject: 'G', participants: [] }; // ghost absent → unnameable
    },
  } as never;

  // Warm the metadata cache so the forceRefresh (storm) path is exercised.
  await getGroupContext(ctx, chatId);
  assert.equal(callCount, 1);

  // Repeated lookups for the unnameable participant must force AT MOST one
  // refetch total — not one per call.
  for (let i = 0; i < 6; i += 1) {
    assert.equal(await getGroupParticipantName(ctx, chatId, ghost), null);
  }
  assert.equal(callCount, 2, 'one forced refetch on the first miss, then suppressed by the negative cache');
});

test('a name learned via the live roster bypasses the participant-name negative cache', async () => {
  const ctx = createAccountContext('/tenants/gpn-learn');
  const chatId = '120363408061498041@g.us';
  const ghost = '5222898389031@lid';
  let callCount = 0;
  ctx.sock = {
    user: { id: 'bot@s.whatsapp.net' },
    groupMetadata: async (jid: string) => {
      callCount += 1;
      return { id: jid, subject: 'G', participants: [] };
    },
  } as never;

  await getGroupContext(ctx, chatId);
  // First miss arms the negative cache.
  assert.equal(await getGroupParticipantName(ctx, chatId, ghost), null);
  const afterMiss = callCount;

  // The sender later messages → their pushName lands in the live roster.
  rememberParticipantName(ctx, ghost, 'Budi');

  // Next lookup resolves from the roster immediately — no new metadata fetch.
  assert.equal(await getGroupParticipantName(ctx, chatId, ghost), 'Budi');
  assert.equal(callCount, afterMiss, 'roster hit must not trigger a metadata fetch');
});
