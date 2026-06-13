// settings-default.test.ts — feature 3: `default` (write __global__ row only).
//
// Verifies setDefault* changes the value seen by UNtouched chats (no per-chat
// row → fallback to __global__) while chats that already have their own value
// are NOT affected. Contrast with setGlobal* which overwrites every row.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.LOG_LEVEL = 'silent';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wazzap-def-cfg-'));

import test from 'node:test';
import assert from 'node:assert/strict';

const { Database } = await import('../../src/db/Database.ts');
const { createRepositories } = await import('../../src/db/repositories/index.ts');

function tmpTenant(prefix: string): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return path.join(folder, 'db');
}

test('setDefaultMode affects untouched chats but not touched ones (feature 3)', () => {
  const dbDir = tmpTenant('wazzap-def-');
  const db = new Database(dbDir);
  try {
    db.open();
    const repos = createRepositories(db);

    const touched = 'touched@g.us';
    const untouched = 'untouched@g.us';

    // touched chat explicitly sets its own mode
    repos.settings.setMode(touched, 'auto');
    assert.equal(repos.settings.getMode(touched), 'auto');

    // change the DEFAULT (only the __global__ row)
    repos.settings.setDefaultMode('hybrid');

    // untouched chat picks up the new default via fallback
    assert.equal(repos.settings.getMode(untouched), 'hybrid', 'untouched chat follows default');
    // touched chat keeps its own value
    assert.equal(repos.settings.getMode(touched), 'auto', 'touched chat is unchanged by default');
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbDir), { recursive: true, force: true });
  }
});

test('setDefaultPermission / setDefaultPrompt write the fallback row', () => {
  const dbDir = tmpTenant('wazzap-def2-');
  const db = new Database(dbDir);
  try {
    db.open();
    const repos = createRepositories(db);

    repos.settings.setDefaultPermission(2);
    repos.settings.setDefaultPrompt('default-personality');

    const fresh = 'fresh@g.us';
    assert.equal(repos.settings.getPermission(fresh), 2, 'untouched chat reads default permission');
    assert.equal(repos.settings.getPrompt(fresh), 'default-personality', 'untouched chat reads default prompt');
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbDir), { recursive: true, force: true });
  }
});

test('setGlobalMode overwrites even touched chats (contrast with default)', () => {
  const dbDir = tmpTenant('wazzap-def3-');
  const db = new Database(dbDir);
  try {
    db.open();
    const repos = createRepositories(db);

    const touched = 'touched@g.us';
    repos.settings.setMode(touched, 'auto');
    repos.settings.setGlobalMode('prefix');
    assert.equal(repos.settings.getMode(touched), 'prefix', 'global overwrites touched chat');
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbDir), { recursive: true, force: true });
  }
});
