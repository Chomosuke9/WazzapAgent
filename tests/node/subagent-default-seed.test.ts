import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.LOG_LEVEL = 'silent';
process.env.REQUIRE_ACTIVATION = 'false';
// Must be set BEFORE importing config (read once at import time).
process.env.SUBAGENT_ENABLED_DEFAULT = 'true';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wazzap-subdef-cfg-'));

import test from 'node:test';
import assert from 'node:assert/strict';

const { Database } = await import('../../src/db/Database.ts');
const { createRepositories } = await import('../../src/db/repositories/index.ts');
const { seedSubagentDefault } = await import('../../src/account/baileysFactory.ts');

function freshRepos() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wazzap-subdef-'));
  const db = new Database(path.join(folder, 'db'));
  db.open();
  return { repos: createRepositories(db), cleanup: () => { db.close(); fs.rmSync(folder, { recursive: true, force: true }); } };
}

test('SUBAGENT_ENABLED_DEFAULT=true seeds the __global__ default once (bug fix)', () => {
  const { repos, cleanup } = freshRepos();
  try {
    // Before seeding: fresh chat follows the SQL default (off).
    assert.equal(repos.settings.getSubagentEnabled('new-chat@g.us'), false);

    seedSubagentDefault(repos);

    // Now an untouched chat inherits the env default via the __global__ fallback.
    assert.equal(repos.settings.getSubagentEnabled('__global__'), true);
    assert.equal(repos.settings.getSubagentEnabled('new-chat@g.us'), true);
    assert.equal(repos.settings.getBotConfig('subagent_default_seeded'), '1');
  } finally {
    cleanup();
  }
});

test('seed is idempotent: a later /subagent default off is not re-clobbered', () => {
  const { repos, cleanup } = freshRepos();
  try {
    seedSubagentDefault(repos);
    assert.equal(repos.settings.getSubagentEnabled('__global__'), true);

    // Owner later disables the default at runtime.
    repos.settings.setDefaultSubagentEnabled(false);
    assert.equal(repos.settings.getSubagentEnabled('__global__'), false);

    // Re-running the seed (e.g. next boot) must NOT re-enable it.
    seedSubagentDefault(repos);
    assert.equal(repos.settings.getSubagentEnabled('__global__'), false, 'marker prevents re-seed');
  } finally {
    cleanup();
  }
});
