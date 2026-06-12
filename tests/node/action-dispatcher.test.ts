import test from 'node:test';
import assert from 'node:assert/strict';
import type WebSocket from 'ws';
import type { AccountEntry } from '../../src/protocol/types.ts';

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

/**
 * Minimal fake of a `ws` WebSocket: OPEN readyState plus a send() that records
 * every transmitted (string) frame so tests can assert delivery + ordering.
 */
class FakeWebSocket {
  readyState = OPEN;
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  frames(): any[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

/**
 * Build a registered account entry bound to a fresh FakeWebSocket. The Baileys
 * socket is a tiny stub (only `user.id` is read by untested branches).
 */
function makeAccount(folderPath: string): { entry: AccountEntry; client: FakeWebSocket } {
  const entry = getOrCreate(folderPath);
  entry.ctx = createAccountContext(folderPath);
  entry.sock = { user: { id: 'bot@s.whatsapp.net' } } as any;
  const client = new FakeWebSocket();
  bindClient(folderPath, client as unknown as WebSocket);
  return { entry, client };
}

test('send_message routes to account A and emits action_ack(ok, result.sent) + send_ack to A', async () => {
  const folderA = '/tenants/dispatch-A';
  const folderB = '/tenants/dispatch-B';
  const { entry: entryA, client: clientA } = makeAccount(folderA);
  const { client: clientB } = makeAccount(folderB);

  // Capture the ctx the wa/ module receives to prove per-account routing.
  let seenFolderPath: string | null = null;
  const sentResult = {
    sent: [{ kind: 'text', contextMsgId: '000125', messageId: 'wamid-abc' }],
    replyTo: null,
  };
  const deps: Partial<DispatchDeps> = {
    sendOutgoing: (async (ctx: any) => {
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

  const ack = frames.find((f) => f.type === 'action_ack');
  assert.ok(ack, 'action_ack present');
  assert.equal(ack.payload.action, 'send_message');
  assert.equal(ack.payload.ok, true);
  assert.equal(ack.payload.detail, 'sent');
  assert.equal(ack.payload.requestId, 'send-1');
  assert.deepEqual(ack.payload.result, sentResult, 'result carries the sent[] shape');

  const sendAck = frames.find((f) => f.type === 'send_ack');
  assert.ok(sendAck, 'legacy send_ack present');
  assert.equal(sendAck.payload.requestId, 'send-1');

  // Account B's client must receive nothing — strict per-account isolation.
  assert.equal(clientB.sent.length, 0, 'account B client untouched');

  remove(folderA);
  remove(folderB);
});

test('kick_member failure emits action_ack(ok:false) with priority code + matching error frame', async () => {
  const folder = '/tenants/dispatch-kick';
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
          { senderRef: 'u1', anchorContextMsgId: '000125' },
          { senderRef: 'u2', anchorContextMsgId: '000126' },
        ],
        mode: 'partial_success',
        autoReplyAnchor: false,
      },
    },
    deps,
  );

  const frames = client.frames();
  const ack = frames.find((f) => f.type === 'action_ack');
  assert.ok(ack, 'action_ack present');
  assert.equal(ack.payload.action, 'kick_member');
  assert.equal(ack.payload.ok, false);
  assert.equal(ack.payload.code, 'permission_denied', 'priority-ordered code wins over send_failed');
  // detail comes from the first failure row with a truthy detail.
  assert.equal(ack.payload.detail, 'network blip');
  assert.deepEqual(ack.payload.result, kickResult, 'raw kick result echoed');

  const err = frames.find((f) => f.type === 'error');
  assert.ok(err, 'matching error frame present');
  assert.equal(err.payload.code, 'permission_denied');
  assert.equal(err.payload.action, 'kick_member');
  assert.equal(err.payload.requestId, 'kick-1');
  assert.equal(err.payload.message, 'kick_member failed');
  assert.equal(err.payload.detail, 'network blip');

  remove(folder);
});

test('mark_read emits NO ack', async () => {
  const folder = '/tenants/dispatch-markread';
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
});
