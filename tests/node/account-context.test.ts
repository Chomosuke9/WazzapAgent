import test from 'node:test';
import assert from 'node:assert/strict';

import { createAccountContext } from '../../migration/node/account/accountContext.ts';
import {
  nextContextMsgId,
  rememberSenderRef,
  resolveSenderByRef,
} from '../../migration/node/identifiers.ts';

// Step 16: two AccountContexts keyed by the SAME chatId must keep fully
// independent per-account state. These tests prove the contextMsgId counter and
// the senderRef registry do not leak across contexts.

const CHAT_ID = '12345@g.us';
const SENDER_A = '111@s.whatsapp.net';
const SENDER_B = '222@s.whatsapp.net';

test('createAccountContext returns fresh, independent collections', () => {
  const a = createAccountContext('/tenants/a');
  const b = createAccountContext('/tenants/b');

  assert.equal(a.folderPath, '/tenants/a');
  assert.equal(b.folderPath, '/tenants/b');
  // Distinct map/set instances — not shared references.
  assert.notStrictEqual(a.contextCounterByChat, b.contextCounterByChat);
  assert.notStrictEqual(a.senderRefRegistryByChat, b.senderRefRegistryByChat);
  assert.notStrictEqual(a.messageCache, b.messageCache);
  assert.notStrictEqual(a.quizMessageIds, b.quizMessageIds);
  assert.notStrictEqual(a.jidQueues, b.jidQueues);
  assert.notStrictEqual(a.pendingForms, b.pendingForms);
});

test('same chatId keeps INDEPENDENT /modelcfg pendingForms across contexts', () => {
  const a = createAccountContext('/tenants/a');
  const b = createAccountContext('/tenants/b');

  // An in-flight /modelcfg form opened on account A for a chatId must not be
  // visible to account B for the SAME chatId (multi-account isolation).
  a.pendingForms.set(CHAT_ID, { type: 'add_model', senderId: SENDER_A });
  assert.equal(b.pendingForms.get(CHAT_ID), undefined,
    'pendingForm opened in A must not appear in B');
  assert.deepEqual(a.pendingForms.get(CHAT_ID), { type: 'add_model', senderId: SENDER_A });

  // Account B can hold its own distinct form for the same chatId.
  b.pendingForms.set(CHAT_ID, { type: 'edit_model', modelId: 'gpt-4o', senderId: SENDER_B });
  // Clearing A's form leaves B's intact.
  a.pendingForms.delete(CHAT_ID);
  assert.equal(a.pendingForms.get(CHAT_ID), undefined);
  assert.deepEqual(b.pendingForms.get(CHAT_ID),
    { type: 'edit_model', modelId: 'gpt-4o', senderId: SENDER_B });
});

test('same chatId keeps INDEPENDENT contextMsgId counters (both start at 000000)', () => {
  const a = createAccountContext('/tenants/a');
  const b = createAccountContext('/tenants/b');

  // Both fresh contexts allocate 000000 first for the same chatId.
  assert.equal(nextContextMsgId(a, CHAT_ID), '000000');
  assert.equal(nextContextMsgId(b, CHAT_ID), '000000');

  // Advancing account A must not advance account B's counter.
  assert.equal(nextContextMsgId(a, CHAT_ID), '000001');
  assert.equal(nextContextMsgId(a, CHAT_ID), '000002');
  // B is still at its second allocation, unaffected by A.
  assert.equal(nextContextMsgId(b, CHAT_ID), '000001');
});

test('same (chatId, senderId) does NOT leak senderRefs across contexts', () => {
  const a = createAccountContext('/tenants/a');
  const b = createAccountContext('/tenants/b');

  // Register a sender only in context A.
  const refA = rememberSenderRef(a, CHAT_ID, SENDER_A, SENDER_A);
  assert.ok(refA, 'context A should mint a senderRef');

  // Context B has never seen this sender for this chat → no resolution.
  assert.equal(resolveSenderByRef(b, CHAT_ID, refA as string), null,
    'senderRef minted in A must not resolve in B');
  // And it DOES resolve back in A.
  assert.equal(resolveSenderByRef(a, CHAT_ID, refA as string), SENDER_A);

  // Independently register a different sender in context B for the same chat.
  const refB = rememberSenderRef(b, CHAT_ID, SENDER_B, SENDER_B);
  assert.ok(refB, 'context B should mint its own senderRef');
  assert.equal(resolveSenderByRef(b, CHAT_ID, refB as string), SENDER_B);
  // B's ref must not resolve in A.
  assert.equal(resolveSenderByRef(a, CHAT_ID, refB as string), null,
    'senderRef minted in B must not resolve in A');
});
