// compat.test.ts — device-aware "compatibility mode": tier mapping, the
// effective-tier resolver (explicit setting vs auto device), persisted
// auto_device, and the plain-text fallback renderers.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.LOG_LEVEL = 'silent';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wazzap-compat-cfg-'));

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deviceToTier,
  tierAllows,
  resolveTier,
  quizFallbackText,
  copyCodeFallbackText,
  buttonsFallbackText,
  carouselFallbackText,
  type InteractiveKind,
} from '../../src/wa/interactive/compat.js';

// Database/repositories read config (DATA_DIR) at import time, so load them
// dynamically AFTER the env is set above.
const { Database } = await import('../../src/db/Database.ts');
const { createRepositories } = await import('../../src/db/repositories/index.ts');

function tmpTenant(prefix: string): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return path.join(folder, 'db');
}

test('deviceToTier maps devices to capability tiers', () => {
  assert.equal(deviceToTier('android'), 'full');
  assert.equal(deviceToTier('ios'), 'semi');
  assert.equal(deviceToTier('web'), 'safe');
  assert.equal(deviceToTier('desktop'), 'safe');
  assert.equal(deviceToTier('unknown'), 'safe');
  assert.equal(deviceToTier(null), 'safe');
});

test('tierAllows: full=all, semi=all except list, safe=none', () => {
  const kinds: InteractiveKind[] = ['list', 'quick_reply', 'cta_copy', 'carousel', 'rich'];
  for (const kind of kinds) {
    assert.equal(tierAllows('full', kind), true, `full allows ${kind}`);
    assert.equal(tierAllows('safe', kind), false, `safe blocks ${kind}`);
  }
  // semi (iOS) differs from full ONLY by single_select / list.
  assert.equal(tierAllows('semi', 'list'), false, 'semi blocks list/single_select');
  assert.equal(tierAllows('semi', 'quick_reply'), true);
  assert.equal(tierAllows('semi', 'rich'), true);
});

test('resolveTier: missing repos → full (pre-feature behavior preserved)', () => {
  assert.equal(resolveTier(undefined, 'peer@s.whatsapp.net'), 'full');
});

test('resolveTier: explicit setting wins; auto derives from device else safe', () => {
  const dbDir = tmpTenant('wazzap-compat-');
  const db = new Database(dbDir);
  try {
    db.open();
    const repos = createRepositories(db);
    const chat = 'peer@s.whatsapp.net';

    // Default is `auto` and no device is known yet → safe (answer 3).
    assert.equal(repos.settings.getCompatibilityMode(chat), 'auto');
    assert.equal(resolveTier(repos, chat), 'safe', 'auto + unknown device → safe');

    // Learn devices → auto follows them.
    repos.settings.setAutoDevice(chat, 'android');
    assert.equal(resolveTier(repos, chat), 'full', 'auto + android → full');
    repos.settings.setAutoDevice(chat, 'ios');
    assert.equal(resolveTier(repos, chat), 'semi', 'auto + ios → semi');

    // An explicit mode overrides the detected device.
    repos.settings.setCompatibilityMode(chat, 'safe');
    assert.equal(resolveTier(repos, chat), 'safe', 'explicit safe wins over android/ios device');
    repos.settings.setCompatibilityMode(chat, 'full');
    assert.equal(resolveTier(repos, chat), 'full', 'explicit full wins');
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbDir), { recursive: true, force: true });
  }
});

test('setAutoDevice persists per-chat, is write-if-changed, and never seeds new chats', () => {
  const dbDir = tmpTenant('wazzap-compat2-');
  const db = new Database(dbDir);
  try {
    db.open();
    const repos = createRepositories(db);
    const chat = 'peer2@s.whatsapp.net';

    repos.settings.setAutoDevice(chat, 'android');
    assert.equal(repos.settings.getAutoDevice(chat), 'android');
    // Re-writing the same value is a no-op (must not throw).
    repos.settings.setAutoDevice(chat, 'android');
    assert.equal(repos.settings.getAutoDevice(chat), 'android');

    // A brand-new chat does NOT inherit a device (auto_device defaults null →
    // resolves to safe), even though it inherits compatibility_mode=auto.
    assert.equal(repos.settings.getAutoDevice('fresh@s.whatsapp.net'), null);
    assert.equal(resolveTier(repos, 'fresh@s.whatsapp.net'), 'safe');
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbDir), { recursive: true, force: true });
  }
});

test('text fallback renderers produce readable plain text', () => {
  const quiz = quizFallbackText('Pick a fruit', [
    { label: 'A', text: 'Apple' },
    { label: 'B', text: 'Banana' },
  ]);
  assert.match(quiz, /Pick a fruit/);
  assert.match(quiz, /1\. Apple/);
  assert.match(quiz, /2\. Banana/);

  const copy = copyCodeFallbackText('ABC123', 'Copy');
  assert.match(copy, /ABC123/);
  assert.ok(copy.includes('```'), 'copy-code fallback uses a monospace block');

  const btns = buttonsFallbackText('Choose', [
    { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: 'Site', url: 'https://e.com' }) },
    { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Yes', id: 'y' }) },
  ]);
  assert.match(btns, /Choose/);
  assert.match(btns, /https:\/\/e\.com/);
  assert.match(btns, /Yes/);

  const carousel = carouselFallbackText('Our cards', [
    { body: 'Card one', footer: 'f1', buttons: [] },
    { body: 'Card two', buttons: [] },
  ]);
  assert.match(carousel, /Our cards/);
  assert.match(carousel, /Card one/);
  assert.match(carousel, /Card two/);
});
