import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.LOG_LEVEL = 'silent';
// env default for require-activation is false
process.env.REQUIRE_ACTIVATION = 'false';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wazzap-act-cfg-'));

import test from 'node:test';
import assert from 'node:assert/strict';

const { Database } = await import('../../src/db/Database.ts');
const { createRepositories } = await import('../../src/db/repositories/index.ts');
const { isActivationRequired, getActivationMessage, DEFAULT_ACTIVATION_MESSAGE } = await import('../../src/wa/botConfig.ts');
const { shouldNotifyNotActivated } = await import('../../src/wa/inbound.ts');

function freshRepos() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wazzap-act-'));
  const db = new Database(path.join(folder, 'db'));
  db.open();
  return { repos: createRepositories(db), cleanup: () => { db.close(); fs.rmSync(folder, { recursive: true, force: true }); } };
}

test('isActivationRequired: env default false, bot_config overrides (feature 6)', () => {
  const { repos, cleanup } = freshRepos();
  try {
    assert.equal(isActivationRequired(repos), false, 'env default false');
    repos.settings.setBotConfig('require_activation', 'on');
    assert.equal(isActivationRequired(repos), true, 'bot_config on overrides env');
    repos.settings.setBotConfig('require_activation', 'off');
    assert.equal(isActivationRequired(repos), false, 'bot_config off overrides env');
  } finally {
    cleanup();
  }
});

test('getActivationMessage: default then custom (feature 1)', () => {
  const { repos, cleanup } = freshRepos();
  try {
    assert.equal(getActivationMessage(repos), DEFAULT_ACTIVATION_MESSAGE);
    repos.settings.setBotConfig('activation_msg', 'Please activate first');
    assert.equal(getActivationMessage(repos), 'Please activate first');
  } finally {
    cleanup();
  }
});

test('not-activated notice is throttled per chat', () => {
  const fp = '/tenants/x';
  const chat = 'g-throttle@g.us';
  assert.equal(shouldNotifyNotActivated(fp, chat), true, 'first tag notifies');
  assert.equal(shouldNotifyNotActivated(fp, chat), false, 'immediate retag is throttled');
  // a different chat is independent
  assert.equal(shouldNotifyNotActivated(fp, 'other@g.us'), true);
});
