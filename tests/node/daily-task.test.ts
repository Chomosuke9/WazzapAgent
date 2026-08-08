import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wazzap-daily-'));
process.env.LOG_LEVEL = 'silent';
process.env.REQUIRE_ACTIVATION = 'false';

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountContext } from '../../src/account/accountContext.ts';
import { rememberSenderRef } from '../../src/wa/domain/identifiers.ts';

const { parseDailyTime, handleDailyTask } = await import('../../src/wa/commands/dailyTask.ts');
const registry = await import('../../src/server/accountRegistry.ts');

function makeCtx(args: string, folderPath: string, account?: ReturnType<typeof createAccountContext>, msg: any = {}) {
  const sent: Record<string, any>[] = [];
  return {
    sent,
    ctx: {
      chatId: '12345@g.us', chatType: 'group', senderId: 's@s.whatsapp.net',
      senderIsAdmin: false, senderIsOwner: false, botIsAdmin: false, args, text: args,
      contextMsgId: null, quotedMessageId: null, senderDisplay: 'Tester', senderRole: null,
      isGroup: true, fromMe: false, group: null, msg, folderPath, account,
      sock: { sendMessage: async (_jid: string, body: Record<string, any>) => { sent.push(body); } },
      repos: undefined,
    } as any,
  };
}

test('parseDailyTime validates and canonicalizes HH:MM', () => {
  assert.equal(parseDailyTime('8:05'), '08:05');
  assert.equal(parseDailyTime('23:59'), '23:59');
  assert.equal(parseDailyTime('24:00'), null);
  assert.equal(parseDailyTime('08:60'), null);
  assert.equal(parseDailyTime('8'), null);
});

test('daily task emits a reliable recurring frame and converts human mentions', async () => {
  const folderPath = '/tenants/daily-A';
  registry.getOrCreate(folderPath);
  try {
    const account = createAccountContext(folderPath);
    const jid = '628123@s.whatsapp.net';
    const expectedRef = rememberSenderRef(account, '12345@g.us', jid, jid);
    const msg = {
      key: { remoteJid: '12345@g.us', id: 'm1', fromMe: false },
      message: { extendedTextMessage: { text: '/daily-task add 08:00 ping @628123', contextInfo: { mentionedJid: [jid] } } },
    };
    const { ctx, sent } = makeCtx('add 08:00 ping @628123', folderPath, account, msg);
    await handleDailyTask(ctx);
    const frame: any = registry.get(folderPath)!.reliableQueue.at(-1);
    assert.equal(frame.type, 'daily_task');
    assert.equal(frame.timeOfDay, '08:00');
    assert.equal(frame.prompt, `ping @628123 (${expectedRef})`);
    assert.match(sent.at(-1)!.text, /08:00/);
  } finally {
    registry.remove(folderPath);
  }
});

test('daily task lists and deletes through bridge-owned task storage', async () => {
  const folderPath = '/tenants/daily-list-delete';
  registry.getOrCreate(folderPath);
  try {
    const { ctx: listCtx } = makeCtx('', folderPath);
    await handleDailyTask(listCtx);
    const listFrame: any = registry.get(folderPath)!.reliableQueue.at(-1);
    assert.deepEqual(listFrame, {
      type: 'daily_task_list', folderPath, chatId: '12345@g.us',
    });

    const { ctx: deleteCtx } = makeCtx('delete a1b2c3d4', folderPath);
    await handleDailyTask(deleteCtx);
    const deleteFrame: any = registry.get(folderPath)!.reliableQueue.at(-1);
    assert.deepEqual(deleteFrame, {
      type: 'daily_task_delete', folderPath, chatId: '12345@g.us', taskId: 'a1b2c3d4',
    });
  } finally {
    registry.remove(folderPath);
  }
});

test('daily task rejects invalid add and delete arguments', async () => {
  const folderPath = '/tenants/daily-B';
  registry.getOrCreate(folderPath);
  try {
    const { ctx, sent } = makeCtx('add 25:00 nope', folderPath);
    await handleDailyTask(ctx);
    assert.equal(registry.get(folderPath)!.reliableQueue.length, 0);
    assert.match(sent.at(-1)!.text, /daily-task/);

    const { ctx: deleteCtx, sent: deleteSent } = makeCtx('delete', folderPath);
    await handleDailyTask(deleteCtx);
    assert.equal(registry.get(folderPath)!.reliableQueue.length, 0);
    assert.match(deleteSent.at(-1)!.text, /daily-task/);
  } finally {
    registry.remove(folderPath);
  }
});

test.after(() => {
  fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});
