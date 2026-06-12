// db-isolation.test.ts — Step 05: per-account DB isolation (the critical fix).
//
// Proves that two tenants, each owning its own `Database` + repository bundle
// pointed at a DISTINCT `db/` dir, NEVER share state. Before this step the
// process-global handles + the `openWithDbDir` early-return guard meant tenant
// #2 silently reused tenant #1's settings/stats/model/activation DBs
// (CONTRACT.md §8 violation). Here we write a setting + a model + an activation
// in tenant A and assert tenant B observes NONE of it, and vice-versa.
//
// Env MUST be set before importing config (config reads env at import time and
// would otherwise resolve a real DATA_DIR). Two distinct temp tenant dirs; both
// Databases are CLOSED in a finally so no handles leak / the test never hangs.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.LOG_LEVEL = 'silent';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wazzap-iso-cfg-'));

import test from 'node:test';
import assert from 'node:assert/strict';

const { Database } = await import('../../src/db/Database.ts');
const { createRepositories } = await import('../../src/db/repositories/index.ts');

function tmpTenant(prefix: string): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return path.join(folder, 'db');
}

function rmParent(dbDir: string): void {
  try {
    fs.rmSync(path.dirname(dbDir), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

test('two AccountEntry Databases on distinct tenant dirs are fully isolated', () => {
  const dbDirA = tmpTenant('wazzap-iso-A-');
  const dbDirB = tmpTenant('wazzap-iso-B-');

  const dbA = new Database(dbDirA);
  const dbB = new Database(dbDirB);

  try {
    dbA.open();
    dbB.open();

    // The two tenants resolve to genuinely different files.
    assert.notEqual(dbA.getSettingsDbPath(), dbB.getSettingsDbPath());
    assert.ok(dbA.getSettingsDbPath().startsWith(dbDirA));
    assert.ok(dbB.getSettingsDbPath().startsWith(dbDirB));

    const reposA = createRepositories(dbA);
    const reposB = createRepositories(dbB);

    const chatId = 'shared-chat@s.whatsapp.net';

    // ── Write a SETTING in A only. ──
    reposA.settings.setPrompt(chatId, 'tenant-A-prompt');
    assert.equal(reposA.settings.getPrompt(chatId), 'tenant-A-prompt');
    assert.equal(
      reposB.settings.getPrompt(chatId),
      null,
      'tenant B must NOT observe tenant A prompt',
    );

    // ── Write a MODEL in A only. ──
    assert.equal(reposA.model.addModel('model-A', 'Model A', '', null, false), true);
    assert.ok(
      reposA.model.getAllModels().some((m) => m.modelId === 'model-A'),
      'tenant A sees its own model',
    );
    assert.equal(
      reposB.model.getAllModels().some((m) => m.modelId === 'model-A'),
      false,
      'tenant B must NOT observe tenant A model',
    );

    // ── Write an ACTIVATION in A only. ──
    const codeA = reposA.activation.generateActivationCode('private', 0, 'owner@A');
    const actA = reposA.activation.activateChat(chatId, codeA.code, 'private');
    assert.equal(actA.success, true);
    assert.equal(reposA.activation.isChatActivated(chatId), true);
    assert.equal(
      reposB.activation.isChatActivated(chatId),
      false,
      'tenant B must NOT observe tenant A activation',
    );
    assert.equal(
      reposB.activation.getAllActivationCodes().length,
      0,
      'tenant B activation_codes must be empty',
    );

    // ── Now the reverse direction: write in B, assert A unaffected. ──
    reposB.settings.setPrompt(chatId, 'tenant-B-prompt');
    assert.equal(reposB.settings.getPrompt(chatId), 'tenant-B-prompt');
    assert.equal(
      reposA.settings.getPrompt(chatId),
      'tenant-A-prompt',
      'tenant A prompt must be unchanged by tenant B write',
    );

    assert.equal(reposB.model.addModel('model-B', 'Model B', '', null, false), true);
    assert.equal(
      reposA.model.getAllModels().some((m) => m.modelId === 'model-B'),
      false,
      'tenant A must NOT observe tenant B model',
    );
  } finally {
    dbA.close();
    dbB.close();
    rmParent(dbDirA);
    rmParent(dbDirB);
  }
});
