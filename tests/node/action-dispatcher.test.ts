import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type WebSocket from 'ws';
import type { AccountEntry, AccountContext } from '../../src/protocol/types.ts';

import {
  getOrCreate,
  bindClient,
  remove,
} from '../../src/server/accountRegistry.ts';
import { createAccountContext } from '../../src/account/accountContext.ts';
import {
  dispatchAction,
  type DispatchDeps,
} from '../../src/account/actionDispatcher.ts';

// The `ws` OPEN constant value is 1 (per the WebSocket spec / ws library).
const OPEN = 1;
const TEST_ROOT = path.join(tmpdir(), `wazzapagent-action-${process.pid}-${Date.now()}`);

/**
 * Minimal fake of a `ws` WebSocket: OPEN readyState plus a send() that records
 * every transmitted (string) frame so tests can assert delivery + ordering.
 */
/** Shape of a parsed WS frame sent by the test subject. */
interface ParsedFrame {
  type: string;
  payload: Record<string, unknown>;
}

class FakeWebSocket {
  readyState = OPEN;
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  frames(): ParsedFrame[] {
    return this.sent.map((s) => JSON.parse(s) as ParsedFrame);
  }
}

/**
 * Build a registered account entry bound to a fresh FakeWebSocket. The Baileys
 * socket is a tiny stub (only `user.id` is read by untested branches).
 */
function makeAccount(folderPath: string): { entry: AccountEntry; client: FakeWebSocket } {
  const entry = getOrCreate(folderPath);
  entry.ctx = createAccountContext(folderPath);
  entry.waStatus = 'open';
  entry.sock = {
    user: { id: 'bot@s.whatsapp.net' },
    authState: {
      creds: {
        registered: true,
        me: { id: 'bot@s.whatsapp.net' },
      },
    },
  } as unknown as NonNullable<AccountEntry['sock']>;
  const client = new FakeWebSocket();
  bindClient(folderPath, client as unknown as WebSocket);
  return { entry, client };
}

function receiptFingerprint(frame: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)]),
      );
    }
    return value;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(frame)))
    .digest('hex');
}

test('send_message routes to account A and emits action_ack(ok, result.sent) + send_ack to A', async () => {
  const folderA = path.join(TEST_ROOT, 'dispatch-A');
  const folderB = path.join(TEST_ROOT, 'dispatch-B');
  const { entry: entryA, client: clientA } = makeAccount(folderA);
  const { client: clientB } = makeAccount(folderB);

  // Capture the ctx the wa/ module receives to prove per-account routing.
  let seenFolderPath: string | null = null;
  let sendCount = 0;
  const sentResult = {
    sent: [{ kind: 'text', contextMsgId: '000125', messageId: 'wamid-abc' }],
    replyTo: null,
  };
  const deps: Partial<DispatchDeps> = {
    sendOutgoing: (async (ctx: AccountContext) => {
      sendCount += 1;
      seenFolderPath = ctx.folderPath;
      return sentResult;
    }) as DispatchDeps['sendOutgoing'],
  };

  await dispatchAction(
    entryA,
    { type: 'send_message', payload: { requestId: 'send-1', chatId: '123@g.us', text: 'hi' } },
    deps,
  );

  // sendOutgoing ran against account A's context (not B's).
  assert.equal(seenFolderPath, folderA, 'sendOutgoing must receive account A ctx');

  const frames = clientA.frames();
  assert.equal(frames.length, 2, 'exactly action_ack + send_ack');

  const ack = frames.find((f) => f.type === 'action_ack') as ParsedFrame | undefined;
  assert.ok(ack, 'action_ack present');
  const ackP = ack!.payload;
  assert.equal(ackP.action, 'send_message');
  assert.equal(ackP.ok, true);
  assert.equal(ackP.detail, 'sent');
  assert.equal(ackP.requestId, 'send-1');
  assert.deepEqual(ackP.result, sentResult, 'result carries the sent[] shape');

  const sendAck = frames.find((f) => f.type === 'send_ack') as ParsedFrame | undefined;
  assert.ok(sendAck, 'legacy send_ack present');
  assert.equal(sendAck!.payload.requestId, 'send-1');

  await dispatchAction(
    entryA,
    { type: 'send_message', payload: { requestId: 'send-1', chatId: '123@g.us', text: 'hi' } },
    deps,
  );
  assert.equal(sendCount, 1, 'same requestId and payload replays without sending twice');
  assert.equal(clientA.frames().length, 4, 'durable receipt replays both terminal frames');

  await dispatchAction(
    entryA,
    { type: 'send_message', payload: { requestId: 'send-1', chatId: '123@g.us', text: 'changed' } },
    deps,
  );
  assert.equal(sendCount, 1, 'same requestId cannot be rebound to a different payload');
  const conflict = clientA.frames().at(-1);
  assert.equal(conflict?.type, 'action_ack');
  assert.equal(conflict?.payload.ok, false);

  // Account B's client must receive nothing — strict per-account isolation.
  assert.equal(clientB.sent.length, 0, 'account B client untouched');

  remove(folderA);
  remove(folderB);
  await rm(folderA, { recursive: true, force: true });
  await rm(folderB, { recursive: true, force: true });
});

test('run_command action_ack preserves captured command outputs', async () => {
  const folder = path.join(TEST_ROOT, 'dispatch-run-command-output');
  const { entry, client } = makeAccount(folder);
  const outputs = ['Daily tasks\n1. 08:00 Send the report'];
  const deps: Partial<DispatchDeps> = {
    dispatchRunCommand: (async () => ({
      ok: true,
      command: 'daily-task',
      detail: 'executed',
      outputs,
    })) as DispatchDeps['dispatchRunCommand'],
  };

  await dispatchAction(
    entry,
    {
      type: 'run_command',
      payload: { requestId: 'cmd-output-1', chatId: '123@g.us', command: '/daily-task' },
    },
    deps,
  );

  const ack = client.frames().find((frame) => frame.type === 'action_ack');
  assert.ok(ack);
  assert.deepEqual(ack.payload.result, { command: 'daily-task', outputs });

  remove(folder);
  await rm(folder, { recursive: true, force: true });
});

test('an action rejected before pairing can reuse its requestId after WhatsApp opens', async () => {
  const folder = path.join(TEST_ROOT, 'dispatch-pre-pair');
  const { entry, client } = makeAccount(folder);
  entry.waStatus = 'connecting';
  (entry.sock!.authState.creds as { me?: unknown }).me = undefined;
  let sendCount = 0;
  const sentResult = {
    sent: [{ kind: 'text', contextMsgId: '000126', messageId: 'wamid-ready' }],
    replyTo: null,
  };
  const deps: Partial<DispatchDeps> = {
    sendOutgoing: (async () => {
      sendCount += 1;
      return sentResult;
    }) as DispatchDeps['sendOutgoing'],
  };
  const frame = {
    type: 'send_message' as const,
    payload: { requestId: 'send-after-pair', chatId: '123@g.us', text: 'hi' },
  };

  await dispatchAction(entry, frame, deps);
  assert.equal(sendCount, 0);
  const unavailable = client.frames().find((item) => item.type === 'action_ack');
  assert.equal(unavailable?.payload.ok, false);
  assert.equal(unavailable?.payload.code, 'send_failed');
  assert.match(String(unavailable?.payload.detail), /pair or reconnect/i);

  entry.waStatus = 'open';
  (entry.sock!.authState.creds as { me?: { id: string } }).me = {
    id: 'bot@s.whatsapp.net',
  };
  await dispatchAction(entry, frame, deps);
  assert.equal(sendCount, 1, 'pre-pair rejection must not reserve the requestId');
  const finalAck = client.frames().filter((item) => item.type === 'action_ack').at(-1);
  assert.equal(finalAck?.payload.ok, true);

  remove(folder);
  await rm(folder, { recursive: true, force: true });
});

test('get_chat_context returns a force-refreshed authoritative group snapshot', async () => {
  const folder = path.join(TEST_ROOT, 'dispatch-chat-context');
  const { entry, client } = makeAccount(folder);
  let metadataCalls = 0;
  entry.ctx.sock = entry.sock;
  entry.sock!.groupMetadata = async () => {
    metadataCalls += 1;
    return {
      id: '123@g.us',
      subject: 'Operators',
      desc: 'Production operations',
      participants: [
        { id: 'bot@s.whatsapp.net', admin: 'admin' },
        { id: 'admin@s.whatsapp.net', admin: 'superadmin' },
      ],
    } as any;
  };

  await dispatchAction(entry, {
    type: 'get_chat_context',
    payload: {
      requestId: 'chatctx-1',
      chatId: '123@g.us',
      forceRefresh: true,
    },
  });

  assert.equal(metadataCalls, 1);
  const ack = client.frames().find((frame) => frame.type === 'action_ack');
  assert.equal(ack?.payload.ok, true);
  assert.deepEqual(ack?.payload.result, {
    chatId: '123@g.us',
    chatName: 'Operators',
    chatType: 'group',
    isGroup: true,
    groupDescription: 'Production operations',
    botIsAdmin: true,
    botIsSuperAdmin: false,
  });

  remove(folder);
  await rm(folder, { recursive: true, force: true });
});

test('legacy sub-agent receipts for the pre-auth Baileys TypeError are retried', async () => {
  const folder = path.join(TEST_ROOT, 'dispatch-legacy-pre-auth');
  const requestId = 'subrec-legacy-pre-auth';
  const frame = {
    type: 'send_message' as const,
    payload: { requestId, chatId: '123@g.us', text: 'recovered report' },
  };
  await mkdir(path.join(folder, 'db'), { recursive: true });
  await writeFile(
    path.join(folder, 'db', 'action-receipts.json'),
    JSON.stringify({
      version: 1,
      receipts: [{
        requestId,
        fingerprint: receiptFingerprint(frame),
        completedAt: Date.now(),
        state: 'complete',
        frames: [{
          type: 'action_ack',
          payload: {
            requestId,
            action: 'send_message',
            ok: false,
            detail: "Cannot read properties of undefined (reading 'id')",
            code: 'send_failed',
          },
        }],
      }],
    }),
    'utf8',
  );
  const { entry, client } = makeAccount(folder);
  let sendCount = 0;
  const deps: Partial<DispatchDeps> = {
    sendOutgoing: (async () => {
      sendCount += 1;
      return {
        sent: [{ kind: 'text', contextMsgId: '000127', messageId: 'wamid-recovered' }],
        replyTo: null,
      };
    }) as DispatchDeps['sendOutgoing'],
  };

  await dispatchAction(entry, frame, deps);
  assert.equal(sendCount, 1, 'definitively unsent legacy recovery must be retried');
  const ack = client.frames().find((item) => item.type === 'action_ack');
  assert.equal(ack?.payload.ok, true);

  remove(folder);
  await rm(folder, { recursive: true, force: true });
});

test('corrupt durable action receipts fail closed without executing the action', async () => {
  const folder = path.join(TEST_ROOT, 'dispatch-corrupt-receipt');
  await mkdir(path.join(folder, 'db'), { recursive: true });
  await writeFile(path.join(folder, 'db', 'action-receipts.json'), '{not-json', 'utf8');
  const { entry, client } = makeAccount(folder);
  let sendCount = 0;
  const deps: Partial<DispatchDeps> = {
    sendOutgoing: (async () => {
      sendCount += 1;
      return { sent: [] };
    }) as DispatchDeps['sendOutgoing'],
  };

  await dispatchAction(
    entry,
    {
      type: 'send_message',
      payload: {
        requestId: 'send-corrupt-receipt',
        chatId: '123@g.us',
        text: 'must not be sent',
      },
    },
    deps,
  );

  assert.equal(sendCount, 0);
  const ack = client.frames().find((frame) => frame.type === 'action_ack');
  assert.equal(ack?.payload.ok, false);
  assert.match(String(ack?.payload.detail), /unreadable/i);

  remove(folder);
  await rm(folder, { recursive: true, force: true });
});

test('kick_member failure emits action_ack(ok:false) with priority code + matching error frame', async () => {
  const folder = path.join(TEST_ROOT, 'dispatch-kick');
  const { entry, client } = makeAccount(folder);

  // Two failures: a send_failed AND a permission_denied. Per CONTRACT.md §2
  // priority [permission_denied, send_failed, not_found, invalid_target],
  // permission_denied must win even though send_failed appears first.
  const kickResult = {
    ok: false,
    succeeded: 0,
    failed: 2,
    results: [
      { target: { senderRef: 'u1' }, ok: false, error: 'send_failed', detail: 'network blip' },
      { target: { senderRef: 'u2' }, ok: false, error: 'permission_denied', detail: 'bot not admin' },
    ],
  };
  const deps: Partial<DispatchDeps> = {
    kickMembers: (async () => kickResult) as DispatchDeps['kickMembers'],
  };

  await dispatchAction(
    entry,
    {
      type: 'kick_member',
      payload: {
        requestId: 'kick-1',
        chatId: '123@g.us',
        targets: [
          { senderRef: 'u1' },
          { senderRef: 'u2' },
        ],
        mode: 'partial_success',
      },
    },
    deps,
  );

  const frames = client.frames();
  const ack = frames.find((f) => f.type === 'action_ack') as ParsedFrame | undefined;
  assert.ok(ack, 'action_ack present');
  const ackP = ack!.payload;
  assert.equal(ackP.action, 'kick_member');
  assert.equal(ackP.ok, false);
  assert.equal(ackP.code, 'permission_denied', 'priority-ordered code wins over send_failed');
  // detail comes from the first failure row with a truthy detail.
  assert.equal(ackP.detail, 'network blip');
  assert.deepEqual(ackP.result, kickResult, 'raw kick result echoed');

  const err = frames.find((f) => f.type === 'error') as ParsedFrame | undefined;
  assert.ok(err, 'matching error frame present');
  const errP = err!.payload;
  assert.equal(errP.code, 'permission_denied');
  assert.equal(errP.action, 'kick_member');
  assert.equal(errP.requestId, 'kick-1');
  assert.equal(errP.message, 'kick_member failed');
  assert.equal(errP.detail, 'network blip');

  remove(folder);
  await rm(folder, { recursive: true, force: true });
});

test('mark_read emits NO ack', async () => {
  const folder = path.join(TEST_ROOT, 'dispatch-markread');
  const { entry, client } = makeAccount(folder);

  let called = false;
  const deps: Partial<DispatchDeps> = {
    markChatRead: (async () => {
      called = true;
    }) as DispatchDeps['markChatRead'],
  };

  await dispatchAction(
    entry,
    { type: 'mark_read', payload: { chatId: '123@g.us', messageId: 'wamid-xyz' } },
    deps,
  );

  assert.equal(called, true, 'markChatRead invoked');
  assert.equal(client.sent.length, 0, 'mark_read must emit no ack/error frame');

  remove(folder);
  await rm(folder, { recursive: true, force: true });
});
