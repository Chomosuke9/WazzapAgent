// Regression: sticker catalog persistence (the "added but not listed" bug).
//
//   BUG 1 (path): the Node /add-sticker + /remove-sticker commands wrote the
//     catalog to the flat `config.stickersDbPath` (<DATA_DIR>/stickers.db),
//     but the Python bridge reads it from `<folderPath>/db/stickers.db` (the
//     per-tenant db/ dir — see python/bridge/sticker_db.py + session.py, which
//     always binds the tenant). So stickers added on the Node side never
//     appeared in the catalog the LLM sees. stickerStore now resolves
//     `<folderPath>/db/stickers.db`, matching Python byte-for-byte.
//
//   BUG 2 (scope): the commands only accepted `global`, not the shared
//     `default` scope keyword the rest of the config commands use, so
//     `/add-sticker default <name>` failed. parseStickerScope now accepts both.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import BetterSqlite3 from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wazzap-stickers-'));
process.env.DATA_DIR = path.join(TMP, 'default-tenant');
process.env.LOG_LEVEL = 'silent';

import test from 'node:test';
import assert from 'node:assert/strict';

const config = (await import('../../src/config.ts')).default;
const {
  GLOBAL_STICKER_CHAT_ID,
  stickerDbPath,
  parseStickerScope,
  upsertWebpSticker,
  upsertLottieSticker,
  deleteSticker,
} = await import('../../src/wa/commands/stickerStore.ts');

test('stickerDbPath resolves to <folderPath>/db/stickers.db (NOT the flat path)', () => {
  const folderPath = path.join(TMP, 'tenant-a');
  assert.equal(stickerDbPath(folderPath), path.join(folderPath, 'db', 'stickers.db'));
  // The old buggy location must NOT be what we resolve.
  assert.notEqual(stickerDbPath(folderPath), path.join(folderPath, 'stickers.db'));
});

test('stickerDbPath falls back to config.stickersDbPath when no folderPath', () => {
  assert.equal(stickerDbPath(undefined), config.stickersDbPath);
  assert.equal(stickerDbPath(''), config.stickersDbPath);
});

test('upsert writes to the per-tenant db/ dir so Python can read it', () => {
  const folderPath = path.join(TMP, 'tenant-write');
  const action = upsertWebpSticker(folderPath, 'chat-1@g.us', 'smile', '/x/smile.webp', 'u@s.whatsapp.net');
  assert.equal(action, 'added');

  const expected = path.join(folderPath, 'db', 'stickers.db');
  // File created exactly where Python's current_tenant_db_root()/stickers.db looks.
  assert.ok(fs.existsSync(expected), 'stickers.db should exist under <folderPath>/db/');
  // And NOT at the old flat location that caused the bug.
  assert.ok(!fs.existsSync(path.join(folderPath, 'stickers.db')), 'must not write the flat path');

  // Re-open the exact file Python would and confirm the row round-trips.
  const db = new BetterSqlite3(expected);
  const row = db
    .prepare('SELECT name, file_path FROM stickers WHERE chat_id = ? AND name = ?')
    .get('chat-1@g.us', 'smile') as { name: string; file_path: string } | undefined;
  db.close();
  assert.ok(row, 'row should be present');
  assert.equal(row!.name, 'smile');
  assert.equal(row!.file_path, '/x/smile.webp');
});

test('upsert is idempotent: second call updates, lottie clears file_path', () => {
  const folderPath = path.join(TMP, 'tenant-update');
  assert.equal(upsertWebpSticker(folderPath, 'c@g.us', 'wave', '/a.webp', 'u'), 'added');
  assert.equal(upsertWebpSticker(folderPath, 'c@g.us', 'wave', '/b.webp', 'u'), 'updated');
  assert.equal(upsertLottieSticker(folderPath, 'c@g.us', 'wave', '{"k":1}', 'u'), 'updated');

  const db = new BetterSqlite3(stickerDbPath(folderPath));
  const row = db
    .prepare('SELECT file_path, lottie_payload FROM stickers WHERE chat_id = ? AND name = ?')
    .get('c@g.us', 'wave') as { file_path: string; lottie_payload: string | null };
  db.close();
  assert.equal(row.file_path, '');
  assert.equal(row.lottie_payload, '{"k":1}');
});

test('deleteSticker removes a row and reports not-found correctly', () => {
  const folderPath = path.join(TMP, 'tenant-del');
  upsertWebpSticker(folderPath, 'c@g.us', 'gone', '/g.webp', 'u');
  assert.equal(deleteSticker(folderPath, 'c@g.us', 'gone'), true);
  assert.equal(deleteSticker(folderPath, 'c@g.us', 'gone'), false);
});

test('per-tenant isolation: tenant A sticker is invisible to tenant B', () => {
  const tenantA = path.join(TMP, 'iso-a');
  const tenantB = path.join(TMP, 'iso-b');
  upsertWebpSticker(tenantA, 'c@g.us', 'only_a', '/a.webp', 'u');

  // Reading tenant B's DB must not see tenant A's sticker (separate files +
  // separate cached connections — the bug the per-path cache prevents).
  upsertWebpSticker(tenantB, 'c@g.us', 'only_b', '/b.webp', 'u');
  const db = new BetterSqlite3(stickerDbPath(tenantB));
  const a = db.prepare('SELECT 1 FROM stickers WHERE name = ?').get('only_a');
  const b = db.prepare('SELECT 1 FROM stickers WHERE name = ?').get('only_b');
  db.close();
  assert.equal(a, undefined, 'tenant A sticker must not leak into tenant B');
  assert.ok(b, 'tenant B sticker should be present');
});

test('parseStickerScope: default and global both map to the shared catalog', () => {
  const def = parseStickerScope('default smile', 'chat-1@g.us');
  assert.equal(def.scope, 'default');
  assert.equal(def.isShared, true);
  assert.equal(def.targetChatId, GLOBAL_STICKER_CHAT_ID);
  assert.equal(def.name, 'smile');
  assert.equal(def.label, ' default');

  const glob = parseStickerScope('global smile', 'chat-1@g.us');
  assert.equal(glob.scope, 'global');
  assert.equal(glob.isShared, true);
  assert.equal(glob.targetChatId, GLOBAL_STICKER_CHAT_ID);
  assert.equal(glob.name, 'smile');
});

test('parseStickerScope: case-insensitive scope token', () => {
  const def = parseStickerScope('DEFAULT Smile', 'chat-1@g.us');
  assert.equal(def.scope, 'default');
  assert.equal(def.name, 'Smile'); // name kept raw; caller lowercases + validates
});

test('parseStickerScope: no scope keyword → per-chat', () => {
  const chat = parseStickerScope('smile', 'chat-1@g.us');
  assert.equal(chat.scope, 'chat');
  assert.equal(chat.isShared, false);
  assert.equal(chat.targetChatId, 'chat-1@g.us');
  assert.equal(chat.name, 'smile');
  assert.equal(chat.label, '');

  const empty = parseStickerScope('', 'chat-1@g.us');
  assert.equal(empty.scope, 'chat');
  assert.equal(empty.name, '');
});
