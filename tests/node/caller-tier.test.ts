// caller-tier.test.ts — `resolveCallerTier` is the shared resolver behind every
// interactive message sent in DIRECT RESPONSE to a caller: the /setting and
// /modelcfg single_select menus (and their button submenus) and the /generate
// cta_copy button. Bug fix: those used to key the interactive-vs-text decision
// purely on the CALLER's device, so a chat explicitly set to `safe`/`semi` still
// got full interactive. An explicit setting must now win; only `auto` falls back
// to caller-device detection.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.LOG_LEVEL = 'silent';
process.env.REQUIRE_ACTIVATION = 'false';

import { getDevice } from 'baileys';
import { resolveCallerTier, deviceToTier, tierAllows } from '../../src/wa/interactive/compat.js';

function reposWithCompat(mode: string): any {
  return { settings: { getCompatibilityMode: (_chatId: string) => mode } };
}

const chatId = 'group@g.us';

test('explicit safe wins → single_select menu suppressed even for an Android caller', () => {
  const tier = resolveCallerTier(reposWithCompat('safe'), chatId, 'ANDROID-LIKE-ID');
  assert.equal(tier, 'safe');
  assert.equal(tierAllows(tier, 'list'), false, 'safe must suppress the interactive menu');
  // cta_copy (the /generate button) is ALSO blocked on safe.
  assert.equal(tierAllows(tier, 'cta_copy'), false, 'safe must suppress cta_copy');
});

test('explicit semi wins → list menus suppressed, but cta_copy still allowed (iOS)', () => {
  const tier = resolveCallerTier(reposWithCompat('semi'), chatId, 'ANY-CALLER-ID');
  assert.equal(tier, 'semi');
  assert.equal(tierAllows(tier, 'list'), false, 'semi must suppress single_select menus');
  assert.equal(tierAllows(tier, 'cta_copy'), true, 'iOS renders cta_copy, so semi keeps it');
});

test('explicit full wins → interactive single_select menu renders', () => {
  const tier = resolveCallerTier(reposWithCompat('full'), chatId, '');
  assert.equal(tier, 'full');
  assert.equal(tierAllows(tier, 'list'), true, 'full keeps the interactive menu');
});

test('auto derives the tier from the caller device (not forced)', () => {
  const callerId = 'SOME-CALLER-MESSAGE-ID';
  const tier = resolveCallerTier(reposWithCompat('auto'), chatId, callerId);
  assert.equal(tier, deviceToTier(getDevice(callerId)), 'auto delegates to caller-device detection');
});

test('auto with a missing caller id resolves to a valid tier without throwing', () => {
  const tier = resolveCallerTier(reposWithCompat('auto'), chatId, undefined);
  assert.ok(['full', 'semi', 'safe'].includes(tier));
});

test('missing repos → tier comes purely from the caller device (no throw)', () => {
  const callerId = 'SOME-CALLER-MESSAGE-ID';
  const tier = resolveCallerTier(undefined, chatId, callerId);
  assert.equal(tier, deviceToTier(getDevice(callerId)));
});
