// schedule-task.test.ts — feature 5: duration parser + handleScheduleTask emits
// a reliable `schedule_task` frame to the acting account via the registry.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wazzap-sched-'));
process.env.LOG_LEVEL = 'silent';
process.env.REQUIRE_ACTIVATION = 'false';

import test from 'node:test';
import assert from 'node:assert/strict';

const { parseScheduleDuration, handleScheduleTask } = await import(
  '../../src/wa/commands/scheduleTask.ts'
);
const registry = await import('../../src/server/accountRegistry.ts');

function makeCtx(args: string, folderPath: string) {
  const sent: Record<string, unknown>[] = [];
  const ctx: Record<string, unknown> = {
    chatId: '12345@g.us',
    chatType: 'group',
    senderId: 's@s.whatsapp.net',
    senderIsAdmin: false,
    senderIsOwner: false,
    botIsAdmin: false,
    args,
    text: args,
    contextMsgId: null,
    quotedMessageId: null,
    senderDisplay: 'Tester',
    senderRole: null,
    isGroup: true,
    fromMe: false,
    group: null,
    msg: {} as Record<string, unknown>,
    folderPath,
    sock: { sendMessage: async (_jid: string, m: Record<string, unknown>) => { sent.push(m); } },
    repos: undefined,
  };
  return { ctx, sent };
}

test('parseScheduleDuration accepts combined / single H,M forms', () => {
  assert.deepEqual(parseScheduleDuration('2H30M'), { hours: 2, minutes: 30, totalMs: (2 * 60 + 30) * 60000 });
  assert.deepEqual(parseScheduleDuration('2H'), { hours: 2, minutes: 0, totalMs: 2 * 3600000 });
  assert.deepEqual(parseScheduleDuration('30M'), { hours: 0, minutes: 30, totalMs: 30 * 60000 });
  // case-insensitive
  assert.deepEqual(parseScheduleDuration('45m'), { hours: 0, minutes: 45, totalMs: 45 * 60000 });
  assert.deepEqual(parseScheduleDuration('1h15m'), { hours: 1, minutes: 15, totalMs: 75 * 60000 });
});

test('parseScheduleDuration rejects invalid / zero / non-duration tokens', () => {
  assert.equal(parseScheduleDuration(''), null);
  assert.equal(parseScheduleDuration('abc'), null);
  assert.equal(parseScheduleDuration('2'), null);     // missing unit
  assert.equal(parseScheduleDuration('H'), null);      // missing number
  assert.equal(parseScheduleDuration('2X'), null);     // bad unit
  assert.equal(parseScheduleDuration('30M30M'), null); // malformed
  assert.equal(parseScheduleDuration('0H0M'), null);   // zero total
  assert.equal(parseScheduleDuration('0M'), null);     // zero total
});

test('handleScheduleTask emits a schedule_task frame with the parsed delay + prompt', async () => {
  const folderPath = '/tenants/sched-A';
  registry.getOrCreate(folderPath); // no client bound -> frame is queued
  try {
    const before = Date.now();
    const { ctx, sent } = makeCtx('2H30M Remind @Budi (abc123) about the meeting', folderPath);
    await handleScheduleTask(ctx);
    const after = Date.now();

    const entry = registry.get(folderPath);
    assert.ok(entry, 'account entry must exist');
    assert.equal(entry!.reliableQueue.length, 1, 'exactly one schedule_task frame queued');
    const frame = entry!.reliableQueue[0];
    assert.equal(frame.type, 'schedule_task');
    assert.equal(frame.folderPath, folderPath);
    assert.equal(frame.chatId, '12345@g.us');
    assert.equal(frame.prompt, 'Remind @Budi (abc123) about the meeting');
    assert.equal(typeof frame.taskId, 'string');
    assert.ok(frame.taskId.length > 0, 'taskId is non-empty');
    const expectedDelay = (2 * 60 + 30) * 60000;
    assert.ok(
      frame.fireAtMs >= before + expectedDelay && frame.fireAtMs <= after + expectedDelay,
      'fireAtMs reflects now + 2h30m',
    );
    // A confirmation message is sent to the chat.
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /scheduled/i);
  } finally {
    registry.remove(folderPath);
  }
});

test('handleScheduleTask rejects missing prompt / bad duration without emitting a frame', async () => {
  const folderPath = '/tenants/sched-B';
  registry.getOrCreate(folderPath);
  try {
    // duration but no prompt
    let r = makeCtx('2H30M', folderPath);
    await handleScheduleTask(r.ctx);
    assert.equal(registry.get(folderPath)!.reliableQueue.length, 0, 'no frame on missing prompt');
    assert.match(r.sent.at(-1).text, /schedule-task/i, 'usage shown');

    // bad duration token
    r = makeCtx('soon do something', folderPath);
    await handleScheduleTask(r.ctx);
    assert.equal(registry.get(folderPath)!.reliableQueue.length, 0, 'no frame on bad duration');
  } finally {
    registry.remove(folderPath);
  }
});

test('handleScheduleTask rejects durations longer than 30 days', async () => {
  const folderPath = '/tenants/sched-C';
  registry.getOrCreate(folderPath);
  try {
    const { ctx, sent } = makeCtx('745H do the thing', folderPath); // 745h > 30 days (720h)
    await handleScheduleTask(ctx);
    assert.equal(registry.get(folderPath)!.reliableQueue.length, 0, 'no frame when > 30 days');
    assert.match(sent.at(-1).text, /30 days/i, 'cap message shown');
  } finally {
    registry.remove(folderPath);
  }
});

test.after(() => {
  try {
    fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
