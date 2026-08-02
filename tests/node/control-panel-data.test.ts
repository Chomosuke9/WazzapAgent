import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Database } from '../../src/db/Database.ts';
import { createRepositories } from '../../src/db/repositories/index.ts';

function fixture(prefix: string): { root: string; db: Database } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const db = new Database(path.join(root, 'db'));
  db.open();
  return { root, db };
}

test('default model selection is explicit and never changes model order', () => {
  const { root, db } = fixture('wazzap-model-default-');
  try {
    const repos = createRepositories(db);
    assert.equal(repos.model.addModel('model-a', 'Model A', '', 4), true);
    assert.equal(repos.model.addModel('model-b', 'Model B', '', 9), true);

    const before = repos.model.getAllModels();
    assert.equal(before.find((model) => model.modelId === 'model-a')?.isDefault, true);
    assert.deepEqual(before.map((model) => model.sortOrder), [4, 9]);

    assert.equal(repos.model.setDefaultModel('model-b'), true);
    const after = repos.model.getAllModels();
    assert.deepEqual(after.map((model) => model.sortOrder), [4, 9]);
    assert.equal(after.find((model) => model.modelId === 'model-a')?.isDefault, false);
    assert.equal(after.find((model) => model.modelId === 'model-b')?.isDefault, true);
    assert.equal(repos.model.getDefaultLlm2Model()?.modelId, 'model-b');
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('model order is normalized to a non-negative sequence on database reopen', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wazzap-model-order-'));
  const dbDir = path.join(root, 'db');
  let db = new Database(dbDir);
  try {
    db.open();
    db.settingsState.db!.run(
      `INSERT INTO llm_models
       (model_id, display_name, description, is_active, is_default, sort_order, vision_support)
       VALUES ('model-low', 'Low', '', 1, 0, -8, 0),
              ('model-high', 'High', '', 1, 1, 12, 0)`,
    );
    db.close();

    db = new Database(dbDir);
    db.open();
    const repos = createRepositories(db);
    assert.deepEqual(repos.model.getAllModels().map((model) => model.sortOrder), [0, 1]);
    assert.equal(repos.model.getDefaultLlm2Model()?.modelId, 'model-high');
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('chat scope names persist in the local directory without creating settings rows', () => {
  const { root, db } = fixture('wazzap-chat-directory-');
  try {
    const repos = createRepositories(db);
    const chatId = '120363000000000@g.us';
    repos.settings.upsertChatDirectory(chatId, 'Project Operations', 'group');

    assert.deepEqual(repos.settings.getChatDirectoryEntry(chatId), {
      chatId,
      displayName: 'Project Operations',
      chatType: 'group',
      updatedAt: repos.settings.getChatDirectoryEntry(chatId)?.updatedAt,
    });
    assert.equal(
      repos.settings.listChatSettings().some((settings) => settings.chatId === chatId),
      false,
      'learning a label must not create an explicit chat settings row',
    );
    repos.settings.upsertChatDirectory(chatId, chatId, 'group');
    assert.equal(
      repos.settings.getChatDirectoryEntry(chatId)?.displayName,
      'Project Operations',
      'a bare JID fallback must not replace the stored friendly name',
    );
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
