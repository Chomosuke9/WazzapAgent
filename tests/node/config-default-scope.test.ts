import test from 'node:test';
import assert from 'node:assert/strict';

process.env.REQUIRE_ACTIVATION = 'false';

import { handleMode } from '../../src/wa/command/mode.js';
import { handlePermission } from '../../src/wa/command/permission.js';
import { handleTrigger } from '../../src/wa/command/trigger.js';
import { handlePrompt } from '../../src/wa/command/prompt.js';

function makeSettingsSpy() {
  const calls: string[] = [];
  const rec = (name: string) => (..._a: any[]) => { calls.push(name); };
  return {
    calls,
    settings: {
      // getters used by no-arg paths (not exercised here)
      getMode: () => 'prefix',
      getTriggers: () => new Set<string>(),
      getPermission: () => 0,
      getPrompt: () => null,
      // setters we assert on
      setMode: rec('setMode'),
      setGlobalMode: rec('setGlobalMode'),
      setDefaultMode: rec('setDefaultMode'),
      setPermission: rec('setPermission'),
      setGlobalPermission: rec('setGlobalPermission'),
      setDefaultPermission: rec('setDefaultPermission'),
      setTriggers: rec('setTriggers'),
      setGlobalTriggers: rec('setGlobalTriggers'),
      setDefaultTriggers: rec('setDefaultTriggers'),
      setPrompt: rec('setPrompt'),
      setGlobalPrompt: rec('setGlobalPrompt'),
      setDefaultPrompt: rec('setDefaultPrompt'),
    },
  };
}

function ctx(over: any) {
  const sent: any[] = [];
  const base = {
    chatId: '123@g.us',
    chatType: 'group',
    senderId: 's@s.whatsapp.net',
    senderIsAdmin: true,
    senderIsOwner: true,
    botIsAdmin: true,
    args: '',
    text: '',
    contextMsgId: null,
    quotedMessageId: null,
    senderDisplay: 'S',
    senderRole: null,
    isGroup: true,
    fromMe: false,
    group: null,
    msg: {} as any,
    folderPath: '/data',
    sock: { user: { id: 'b@s.whatsapp.net', name: 'Bot' }, sendMessage: async (_j: string, c: any) => { sent.push(c); } },
    sentRef: sent,
    ...over,
  };
  return base as any;
}

test('/mode default calls setDefaultMode (owner)', async () => {
  const spy = makeSettingsSpy();
  await handleMode(ctx({ args: 'default auto', repos: spy }));
  assert.ok(spy.calls.includes('setDefaultMode'));
  assert.ok(!spy.calls.includes('setGlobalMode'));
  assert.ok(!spy.calls.includes('setMode'));
});

test('/mode global calls setGlobalMode; plain calls setMode', async () => {
  const g = makeSettingsSpy();
  await handleMode(ctx({ args: 'global hybrid', repos: g }));
  assert.ok(g.calls.includes('setGlobalMode'));
  const p = makeSettingsSpy();
  await handleMode(ctx({ args: 'auto', repos: p }));
  assert.ok(p.calls.includes('setMode'));
});

test('/mode default rejected for non-owner', async () => {
  const spy = makeSettingsSpy();
  const c = ctx({ args: 'default auto', repos: spy, senderIsOwner: false, senderIsAdmin: true });
  await handleMode(c);
  assert.equal(spy.calls.length, 0, 'no setter called for non-owner default');
  assert.ok(c.sentRef.some((m: any) => /owner/i.test(m.text || '')));
});

test('/permission default calls setDefaultPermission', async () => {
  const spy = makeSettingsSpy();
  await handlePermission(ctx({ args: 'default 2', repos: spy }));
  assert.ok(spy.calls.includes('setDefaultPermission'));
});

test('/trigger default calls setDefaultTriggers', async () => {
  const spy = makeSettingsSpy();
  await handleTrigger(ctx({ args: 'default all', repos: spy }));
  assert.ok(spy.calls.includes('setDefaultTriggers'));
});

test('/prompt default calls setDefaultPrompt', async () => {
  const spy = makeSettingsSpy();
  await handlePrompt(ctx({ args: 'default you are helpful', repos: spy }));
  assert.ok(spy.calls.includes('setDefaultPrompt'));
});
