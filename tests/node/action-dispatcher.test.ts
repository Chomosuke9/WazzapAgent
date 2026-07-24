import test from 'node:test';
import assert from 'node:assert/strict';
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
  entry.sock = { user: { id: 'bot@s.whatsapp.net' } } as unknown as NonNullable<AccountEntry['sock']>;
  const client = new FakeWebSocket();
  bindClient(folderPath, client as unknown as WebSocket);
  return { entry, client };
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
