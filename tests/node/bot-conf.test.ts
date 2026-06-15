import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.LOG_LEVEL = 'silent';
process.env.REQUIRE_ACTIVATION = 'false';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wazzap-botconf-cfg-'));

import test from 'node:test';
import assert from 'node:assert/strict';

const { handleBotConf } = await import('../../src/wa/commands/bot-conf.ts');
const { Database } = await import('../../src/db/Database.ts');
const { createRepositories } = await import('../../src/db/repositories/index.ts');

function settingsSpy() {
  const calls: Array<[string, ...any[]]> = [];
  const store: Record<string, string | null> = {};
  return {
    calls,
    store,
    getBotConfig: (k: string) => store[k] ?? null,
    setBotConfig: (k: string, v: string | null) => { calls.push(['setBotConfig', k, v]); store[k] = v; },
    getPrompt: (_c: string) => null,
    setDefaultPrompt: (v: string | null) => { calls.push(['setDefaultPrompt', v]); },
  };
}

function ctx(args: string, settings: any) {
  const sent: any[] = [];
  return {
    o: sent,
    c: {
      chatId: '123@g.us', chatType: 'group', senderId: 's', senderIsAdmin: true, senderIsOwner: true,
      botIsAdmin: true, args, text: args, contextMsgId: null, quotedMessageId: null, senderDisplay: 'S',
      senderRole: null, isGroup: true, fromMe: false, group: null, msg: {} as any, folderPath: '/data',
      sock: { sendMessage: async (_j: string, m: any) => { sent.push(m); } }, repos: { settings },
    } as any,
  };
}

test('/bot-conf no args shows usage + current values', async () => {
  const s = settingsSpy();
  const { c, o } = ctx('', s);
  await handleBotConf(c);
  assert.ok(o.some((m) => /bot-conf/i.test(m.text) && /Nilai saat ini/i.test(m.text)));
});

test('/bot-conf activation-msg sets and clears', async () => {
  const s = settingsSpy();
  let r = ctx('activation-msg Halo aktifkan dulu ya', s);
  await handleBotConf(r.c);
  assert.deepEqual(s.calls.at(-1), ['setBotConfig', 'activation_msg', 'Halo aktifkan dulu ya']);

  r = ctx('activation-msg clear', s);
  await handleBotConf(r.c);
  assert.deepEqual(s.calls.at(-1), ['setBotConfig', 'activation_msg', null]);
});

test('/bot-conf require-activation on/off', async () => {
  const s = settingsSpy();
  await handleBotConf(ctx('require-activation on', s).c);
  assert.deepEqual(s.calls.at(-1), ['setBotConfig', 'require_activation', 'on']);
  await handleBotConf(ctx('require-activation off', s).c);
  assert.deepEqual(s.calls.at(-1), ['setBotConfig', 'require_activation', 'off']);
});

test('/bot-conf prompt-override writes default prompt', async () => {
  const s = settingsSpy();
  await handleBotConf(ctx('prompt-override you are a helpful bot', s).c);
  assert.deepEqual(s.calls.at(-1), ['setDefaultPrompt', 'you are a helpful bot']);
  await handleBotConf(ctx('prompt-override clear', s).c);
  assert.deepEqual(s.calls.at(-1), ['setDefaultPrompt', null]);
});

test('bot_config DB roundtrip via SettingsRepository', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wazzap-botconf-'));
  const dbDir = path.join(folder, 'db');
  const db = new Database(dbDir);
  try {
    db.open();
    const repos = createRepositories(db);
    assert.equal(repos.settings.getBotConfig('require_activation'), null);
    repos.settings.setBotConfig('require_activation', 'on');
    assert.equal(repos.settings.getBotConfig('require_activation'), 'on');
    repos.settings.setBotConfig('require_activation', null);
    assert.equal(repos.settings.getBotConfig('require_activation'), null);
  } finally {
    db.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
