import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Set env before importing anything that pulls in config.ts (info.ts ->
// botConfig.ts -> config.ts). REQUIRE_ACTIVATION=false makes the activation
// gate default to "not required" unless a test overrides getBotConfig.
process.env.LOG_LEVEL = 'silent';
process.env.REQUIRE_ACTIVATION = 'false';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wazzap-info-cfg-'));

import test from 'node:test';
import assert from 'node:assert/strict';

const { handleInfoCommand } = await import('../../src/wa/commands/info.ts');

function makeCtx(overrides: Record<string, any> = {}) {
  const sent: any[] = [];
  const settings = {
    getMode: () => 'hybrid',
    getPermission: () => 2,
    getBotConfig: () => null, // -> isActivationRequired falls back to env (false)
  };
  const activation = { isChatActivated: () => true };
  const ctx: any = {
    chatId: '123@g.us',
    chatType: 'group',
    senderId: '628000@s.whatsapp.net',
    senderIsAdmin: false,
    senderIsOwner: false,
    botIsAdmin: true,
    args: '',
    text: '',
    contextMsgId: null,
    quotedMessageId: null,
    senderDisplay: 'Alice',
    senderRole: { isAdmin: false, isSuperAdmin: false },
    isGroup: true,
    fromMe: false,
    group: {
      name: 'My Group',
      participants: [{}, {}, {}],
      botIsAdmin: true,
      botIsSuperAdmin: false,
      description: 'SHOULD NOT APPEAR',
    },
    msg: { key: { id: 'ABCD1234567890' } },
    folderPath: '/data',
    sock: { sendMessage: async (_j: string, m: any) => { sent.push(m); } },
    repos: { settings, activation },
    ...overrides,
  };
  return { sent, ctx };
}

test('/info (group) adds Device, Mode, Permission and Uptime; drops Description', async () => {
  const { sent, ctx } = makeCtx();
  await handleInfoCommand(ctx);
  assert.equal(sent.length, 1);
  const text = sent[0].text;
  assert.match(text, /Device: /);
  assert.match(text, /Mode: hybrid/);
  assert.match(text, /Permission: 2 \(delete & mute\)/);
  assert.match(text, /Bot status:/);
  assert.match(text, /Uptime: /);
  assert.doesNotMatch(text, /Description:/);
  assert.doesNotMatch(text, /SHOULD NOT APPEAR/);
});

test('/info activation line shows "not required" by default', async () => {
  const { sent, ctx } = makeCtx();
  await handleInfoCommand(ctx);
  assert.match(sent[0].text, /Activation: not required/);
});

test('/info activation line shows required + activated when gate is on', async () => {
  const { sent, ctx } = makeCtx({
    repos: {
      settings: { getMode: () => 'auto', getPermission: () => 0, getBotConfig: () => 'on' },
      activation: { isChatActivated: () => true },
    },
  });
  await handleInfoCommand(ctx);
  assert.match(sent[0].text, /Activation: required \(activated\)/);
});

test('/info (private) shows chat info + uptime, no group section', async () => {
  const { sent, ctx } = makeCtx({ isGroup: false, chatType: 'private', group: null });
  await handleInfoCommand(ctx);
  const text = sent[0].text;
  assert.match(text, /Type: private/);
  assert.match(text, /Uptime: /);
  assert.doesNotMatch(text, /Group info:/);
});
