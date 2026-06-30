import test from 'node:test';
import assert from 'node:assert/strict';

process.env.REQUIRE_ACTIVATION = 'false';

import { handlePermission } from '../../src/wa/commands/permission.js';
import { handleTrigger } from '../../src/wa/commands/trigger.js';
import { handlePrompt } from '../../src/wa/commands/prompt.js';

function makeSettingsSpy() {
  const calls: string[] = [];
  const rec = (name: string) => (..._a: unknown[]) => { calls.push(name); };
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

function ctx(over: Record<string, unknown>): Record<string, unknown> {
  const sent: Record<string, unknown>[] = [];
  const base: Record<string, unknown> = {
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
    msg: {} as Record<string, unknown>,
    folderPath: '/data',
    sock: { user: { id: 'b@s.whatsapp.net', name: 'Bot' }, sendMessage: async (_j: string, c: Record<string, unknown>) => { sent.push(c); } },
    sentRef: sent,
    ...over,
  };
  return base;
}

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
