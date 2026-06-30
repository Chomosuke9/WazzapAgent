// button-registry.test.ts — offline unit tests for the auto-discovered button
// registry (no socket, no WS, no DB). Covers prefix matching, init-time
// duplicate detection, and the central activation + permission gates that
// `dispatchButton` now enforces declaratively (the gates each inline button
// handler used to re-implement).
//
// Env MUST be set before importing config / ButtonRegistry (config reads env at
// import time). REQUIRE_ACTIVATION=true so the activation gate is live — the
// `requireActivation: false` bypass is then observable.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wazzap-btnreg-'));
const OWNER_JID = '15551234567@s.whatsapp.net';

process.env.DATA_DIR = TMP_DATA_DIR;
process.env.BOT_OWNER_JIDS = OWNER_JID;
process.env.REQUIRE_ACTIVATION = 'true';
process.env.LOG_LEVEL = 'silent';

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  findButtonHandler,
  dispatchButton,
  buildButtonRegistry,
  __setButtonRegistryForTests,
} = await import('../../src/wa/command/ButtonRegistry.ts');
import type { ButtonContext, ButtonHandler } from '../../src/wa/command/ButtonContext.js';

/** Minimal fake Baileys socket: records every sendMessage call. */
function makeSock() {
  const calls: { chatId: string; content: Record<string, unknown> }[] = [];
  return {
    sendMessage: async (chatId: string, content: Record<string, unknown>) => {
      calls.push({ chatId, content });
      return { key: { id: 'sent' } };
    },
    _calls: calls,
  };
}

/** Build a ButtonContext with overridable gate-relevant fields. */
function makeBc(over: Partial<ButtonContext> & { sock: Record<string, unknown> }): ButtonContext {
  return {
    sock: over.sock,
    account: over.account ?? ({
      folderPath: '/tenants/btnreg',
      // Chat is NOT activated, so the activation gate (when active) blocks.
      repos: { activation: { isChatActivated: () => false } },
    } as Record<string, unknown>),
    msg: {} as Record<string, unknown>,
    chatId: over.chatId ?? '111@s.whatsapp.net',
    senderId: over.senderId ?? '999@s.whatsapp.net',
    isGroup: over.isGroup ?? false,
    group: over.group ?? null,
    senderRole: over.senderRole ?? { isAdmin: false, isSuperAdmin: false },
    senderIsAdmin: over.senderIsAdmin ?? false,
    senderIsOwner: over.senderIsOwner ?? false,
  };
}

test('findButtonHandler resolves by longest-prefix and returns null for unowned ids (qz:)', () => {
  const short: ButtonHandler = { prefixes: ['a'], run: () => {} };
  const long: ButtonHandler = { prefixes: ['abc'], run: () => {} };
  const map = new Map<string, ButtonHandler>([
    ['a', short],
    ['abc', long],
  ]);
  __setButtonRegistryForTests(map);

  const match = findButtonHandler('abcdef');
  assert.ok(match, 'a registered prefix must match');
  assert.equal(match!.handler, long, 'longest matching prefix wins');
  assert.equal(match!.payload, 'def', 'matched prefix is stripped from payload');

  // Quiz replies have no registered handler → fall through (null).
  assert.equal(findButtonHandler('qz:abc'), null, 'qz: must not match any handler');
});

test('buildButtonRegistry throws on a duplicate prefix', () => {
  const h1: ButtonHandler = { prefixes: ['dup:'], run: () => {} };
  const h2: ButtonHandler = { prefixes: ['dup:'], run: () => {} };
  assert.throws(
    () => buildButtonRegistry([h1, h2]),
    /Duplicate button prefix registered: dup:/,
  );
});

test('dispatchButton returns false for an unmatched id (caller falls through)', async () => {
  __setButtonRegistryForTests(new Map());
  const sock = makeSock();
  const handled = await dispatchButton(makeBc({ sock }), 'qz:answer-A');
  assert.equal(handled, false, 'unmatched id must not be handled');
  assert.equal(sock._calls.length, 0, 'no message sent for an unmatched id');
});

test('dispatchButton enforces the permission gate: denies non-owner non-admin, allows owner', async () => {
  let ran = 0;
  const handler: ButtonHandler = {
    prefixes: ['settings:'],
    permission: 'owner or (isGroup and isAdmin)',
    // Isolate the permission gate from the activation gate.
    requireActivation: false,
    run: () => {
      ran += 1;
    },
  };
  __setButtonRegistryForTests(new Map([['settings:', handler]]));

  // Non-owner, non-admin, private chat → denied (handled, but run NOT invoked).
  const denySock = makeSock();
  const denied = await dispatchButton(
    makeBc({ sock: denySock, senderIsOwner: false, senderIsAdmin: false, isGroup: false }),
    'settings:model',
  );
  assert.equal(denied, true, 'a recognised-but-denied tap is still handled');
  assert.equal(ran, 0, 'denied tap must NOT run the handler');
  assert.equal(denySock._calls.length, 1, 'a generic denial reply is sent');
  assert.match(String(denySock._calls[0].content?.text ?? ''), /❌/);

  // Owner → permitted, handler runs.
  const okSock = makeSock();
  const allowed = await dispatchButton(
    makeBc({ sock: okSock, senderIsOwner: true }),
    'settings:model',
  );
  assert.equal(allowed, true, 'permitted tap is handled');
  assert.equal(ran, 1, 'permitted tap runs the handler');
  assert.equal(okSock._calls.length, 0, 'no denial reply for a permitted tap');
});

test('requireActivation:false bypasses the activation gate; default true blocks an unactivated chat', async () => {
  let bypassRan = 0;
  let gatedRan = 0;
  const bypass: ButtonHandler = {
    prefixes: ['x:'],
    permission: 'public',
    requireActivation: false,
    run: () => {
      bypassRan += 1;
    },
  };
  const gated: ButtonHandler = {
    prefixes: ['y:'],
    permission: 'public',
    // requireActivation defaults to true.
    run: () => {
      gatedRan += 1;
    },
  };
  __setButtonRegistryForTests(
    new Map<string, ButtonHandler>([
      ['x:', bypass],
      ['y:', gated],
    ]),
  );

  // REQUIRE_ACTIVATION=true + chat not activated + non-owner.
  const sock = makeSock();
  const handledBypass = await dispatchButton(makeBc({ sock }), 'x:go');
  assert.equal(handledBypass, true);
  assert.equal(bypassRan, 1, 'requireActivation:false must bypass the activation gate and run');

  const handledGated = await dispatchButton(makeBc({ sock }), 'y:go');
  assert.equal(handledGated, true, 'an activation-gated tap is still "handled" (suppressed)');
  assert.equal(gatedRan, 0, 'default requireActivation blocks the unactivated chat');
});

test.after(() => {
  try {
    fs.rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
