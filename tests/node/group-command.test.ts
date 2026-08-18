import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wazzap-group-'));
process.env.LOG_LEVEL = 'silent';
process.env.REQUIRE_ACTIVATION = 'false';

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountContext } from '../../src/account/accountContext.ts';
import { rememberSenderRef } from '../../src/wa/domain/identifiers.ts';
import { groupCommand, handleGroup } from '../../src/wa/commands/group.ts';
import { dispatchRunCommand } from '../../src/wa/runCommand.ts';
import { initCommandRegistry } from '../../src/wa/command/CommandRegistry.ts';
import * as registry from '../../src/server/accountRegistry.ts';

test.before(async () => {
  await initCommandRegistry();
});

function makeCtx(args: string, folderPath: string) {
  const calls: Array<{ kind: string; value: any }> = [];
  const account = createAccountContext(folderPath);
  account.messageCache.set('quoted-1', {
    key: { remoteJid: '12345@g.us', id: 'quoted-1', fromMe: false, participant: 'u@s.whatsapp.net' },
    message: { conversation: 'target' },
  } as any);
  const sock = {
    user: { id: 'bot@s.whatsapp.net' },
    sendMessage: async (_jid: string, body: any) => { calls.push({ kind: 'send', value: body }); },
    groupSettingUpdate: async (_jid: string, value: string) => { calls.push({ kind: 'setting', value }); },
    groupUpdateDescription: async (_jid: string, value: string) => { calls.push({ kind: 'description', value }); },
    groupMetadata: async () => ({
      id: '12345@g.us',
      subject: 'Test group',
      participants: [{ id: 'bot@s.whatsapp.net', admin: 'admin' }],
    }),
  };
  account.sock = sock as any;
  account.forwarder = { forwardIncoming: () => undefined } as any;
  return {
    calls,
    ctx: {
      chatId: '12345@g.us', chatType: 'group', senderId: 'admin@s.whatsapp.net',
      senderIsAdmin: true, senderIsOwner: false, botIsAdmin: true, args, text: args,
      contextMsgId: null, quotedMessageId: 'quoted-1', senderDisplay: 'Admin', senderRole: null,
      isGroup: true, fromMe: false, group: null, msg: {}, folderPath, account, sock, repos: undefined,
    } as any,
  };
}

test('group command is group-admin/from-me gated and also checks bot admin', async () => {
  assert.equal(groupCommand.permission, 'group and (admin or from_me)');
  const { ctx, calls } = makeCtx('close', '/tenants/group-gate');
  ctx.botIsAdmin = false;
  await handleGroup(ctx);
  assert.equal(calls.some((c) => c.kind === 'setting'), false);
  assert.match(calls.at(-1)!.value.text, /bot must be a group admin/i);
});

test('group close/open/description call the Baileys group APIs', async () => {
  for (const [args, kind, value] of [
    ['close', 'setting', 'announcement'],
    ['open', 'setting', 'not_announcement'],
    ['description New description', 'description', 'New description'],
  ] as const) {
    const { ctx, calls } = makeCtx(args, `/tenants/group-${args}`);
    await handleGroup(ctx);
    assert.ok(calls.some((c) => c.kind === kind && c.value === value));
  }
});

test('LLM run_command executes group commands with the bot own admin role', async () => {
  const r = makeCtx('', '/tenants/group-run-command-bot');
  r.ctx.sock.groupMetadata = async () => ({
    id: r.ctx.chatId,
    subject: 'Test group',
    participants: [
      { id: 'bot@s.whatsapp.net', admin: 'admin' },
    ],
  });
  r.ctx.account.sock = r.ctx.sock;

  const result = await dispatchRunCommand(r.ctx.account, {
    chatId: r.ctx.chatId,
    command: '/group open',
  });

  assert.equal(result.ok, true);
  assert.ok(r.calls.some((call) => (
    call.kind === 'setting' && call.value === 'not_announcement'
  )));
});

test('LLM run_command returns text sent by the command for LLM history', async () => {
  const r = makeCtx('', '/tenants/group-run-command-output');
  r.ctx.account.sock = r.ctx.sock;

  const result = await dispatchRunCommand(r.ctx.account, {
    chatId: r.ctx.chatId,
    command: '/group unknown-action',
  });

  assert.equal(result.ok, true);
  assert.equal(result.command, 'group');
  assert.equal(result.outputs.length, 1);
  assert.match(result.outputs[0], /group management/i);
});

test('group pin and delete operate on the replied message key', async () => {
  let r = makeCtx('pin 7', '/tenants/group-pin');
  await handleGroup(r.ctx);
  const pin = r.calls.find((c) => c.kind === 'send' && c.value.pin);
  assert.equal(pin!.value.pin.id, 'quoted-1');
  assert.equal(pin!.value.time, 604800);

  r = makeCtx('delete', '/tenants/group-delete');
  await handleGroup(r.ctx);
  const deletion = r.calls.find((c) => c.kind === 'send' && c.value.delete);
  assert.equal(deletion!.value.delete.id, 'quoted-1');
});

test('human group admins bypass bot moderation permission level 0', async () => {
  const r = makeCtx('delete', '/tenants/group-human-delete-perm0');
  r.ctx.repos = { settings: { getPermission: () => 0 } };
  r.ctx.fromMe = false;
  await handleGroup(r.ctx);
  assert.ok(r.calls.some((call) => call.kind === 'send' && call.value.delete));
});

test('self-triggered bot may delete at permission level 1', async () => {
  const r = makeCtx('delete', '/tenants/group-bot-delete-perm1');
  r.ctx.fromMe = true;
  r.ctx.repos = { settings: { getPermission: () => 1 } };
  await handleGroup(r.ctx);
  assert.ok(r.calls.some((call) => call.kind === 'send' && call.value.delete));
});

test('self-triggered bot moderation obeys permission thresholds 1/2/3', async () => {
  for (const [args, level, required] of [
    ['delete', 0, 1],
    ['mute @Alice (abc123) 15', 1, 2],
    ['kick @Alice (abc123)', 2, 3],
  ] as const) {
    const r = makeCtx(args, `/tenants/group-bot-permission-${level}`);
    r.ctx.fromMe = true;
    r.ctx.repos = { settings: { getPermission: () => level } };
    await handleGroup(r.ctx);
    assert.match(r.calls.at(-1)!.value.text, new RegExp(`permission ${required} is required`, 'i'));
    assert.equal(r.calls.some((call) => call.value?.delete), false);
    assert.equal(r.calls.some((call) => call.kind === 'participants'), false);
  }
});

test('group mute emits tenant-scoped set_chat_mute event', async () => {
  const folderPath = '/tenants/group-mute';
  registry.getOrCreate(folderPath);
  try {
    const { ctx } = makeCtx('mute @Alice (abc123) 45', folderPath);
    ctx.fromMe = true;
    ctx.repos = { settings: { getPermission: () => 2 } };
    await handleGroup(ctx);
    const frame: any = registry.get(folderPath)!.reliableQueue.at(-1);
    assert.equal(frame.type, 'set_chat_mute');
    assert.equal(frame.senderRef, 'abc123');
    assert.equal(frame.durationMinutes, 45);
    assert.equal(frame.folderPath, folderPath);
  } finally {
    registry.remove(folderPath);
  }
});

test('group mute converts a human WhatsApp @mention to senderRef form', async () => {
  const folderPath = '/tenants/group-human-mute';
  registry.getOrCreate(folderPath);
  try {
    const r = makeCtx('mute @628123 15', folderPath);
    const jid = '628123@s.whatsapp.net';
    const expectedRef = rememberSenderRef(r.ctx.account, r.ctx.chatId, jid, jid);
    r.ctx.msg = {
      key: { remoteJid: r.ctx.chatId, id: 'command-1', fromMe: false },
      message: {
        extendedTextMessage: {
          text: '/group mute @628123 15',
          contextInfo: { mentionedJid: [jid] },
        },
      },
    };
    await handleGroup(r.ctx);
    const frame: any = registry.get(folderPath)!.reliableQueue.at(-1);
    assert.equal(frame.type, 'set_chat_mute');
    assert.equal(frame.senderRef, expectedRef);
    assert.equal(frame.durationMinutes, 15);
  } finally {
    registry.remove(folderPath);
  }
});

test('group kick resolves senderRef and removes only the requested non-admin member', async () => {
  const r = makeCtx('', '/tenants/group-kick');
  const targetJid = '628555@s.whatsapp.net';
  const targetRef = rememberSenderRef(r.ctx.account, r.ctx.chatId, targetJid, targetJid)!;
  r.ctx.args = `kick @Alice (${targetRef})`;
  r.ctx.fromMe = true;
  r.ctx.repos = { settings: { getPermission: () => 3 } };
  r.ctx.sock.groupMetadata = async () => ({
    id: r.ctx.chatId,
    subject: 'Test group',
    participants: [
      { id: 'bot@s.whatsapp.net', admin: 'admin' },
      { id: targetJid, admin: null },
    ],
  });
  r.ctx.sock.groupParticipantsUpdate = async (_jid: string, targets: string[], action: string) => {
    r.calls.push({ kind: 'participants', value: { targets, action } });
    return [{ jid: targetJid, status: 200 }];
  };
  r.ctx.account.sock = r.ctx.sock;

  await handleGroup(r.ctx);

  assert.deepEqual(
    r.calls.find((call) => call.kind === 'participants')?.value,
    { targets: [targetJid], action: 'remove' },
  );
});

test.after(() => {
  fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});
