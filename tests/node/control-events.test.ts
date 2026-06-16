// control-events.test.ts — Step 21: control events route through the account
// registry (per-account), each stamped with a top-level `folderPath`.
//
// Env MUST be set before importing config/db/connection (config reads env at
// import time, and db resolves its SQLite paths from `config.dataDir`).
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wazzap-ctrl-'));
const OWNER_JID = '15551234567@s.whatsapp.net';

process.env.DATA_DIR = TMP_DATA_DIR;
process.env.BOT_OWNER_JIDS = OWNER_JID;
process.env.REQUIRE_ACTIVATION = 'false';
process.env.LOG_LEVEL = 'silent';

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import type WebSocket from 'ws';

const { Database } = await import('../../src/db/Database.ts');
const { createRepositories } = await import('../../src/db/repositories/index.ts');
const registry = await import('../../src/server/accountRegistry.ts');
const { handleButtonResponse } = await import('../../src/wa/connection.ts');
const { createAccountContext } = await import('../../src/account/accountContext.ts');

// Button taps now dispatch through the auto-discovered ButtonRegistry (the old
// inline `model_select:` branch moved into `commands/setting.ts`); populate it
// once before exercising handleButtonResponse (mirrors the gateway bootstrap()).
before(async () => {
  const { initButtonRegistry } = await import(
    '../../src/wa/command/ButtonRegistry.ts'
  );
  await initButtonRegistry();
});

// Step 05: each AccountContext carries its tenant's repositories. The button
// handler's model_select path writes via `ctx.repos.model`, so attach a real
// (per-test-dir) Database + repository bundle.
const database = new Database(path.join(TMP_DATA_DIR, 'db'));
database.open();
const repos = createRepositories(database);

// The `ws` OPEN constant value is 1 (per the WebSocket spec / ws library).
const OPEN = 1;

/** Minimal fake `ws` client: OPEN + records every transmitted (string) frame. */
class FakeWebSocket {
  readyState = OPEN;
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
}

/** Minimal fake Baileys socket: only `sendMessage` is exercised here. */
function makeSock() {
  const calls: unknown[][] = [];
  return {
    user: { id: 'bot@s.whatsapp.net' },
    sendMessage: async (...args: unknown[]) => {
      calls.push(args);
    },
    _calls: calls,
  };
}

/** Synthesize a `model_select:` button-response message for `chatId`. */
function makeModelSelectMsg(chatId: string, modelId: string): any {
  return {
    key: { remoteJid: chatId, fromMe: false, id: `btn_${Date.now()}` },
    message: {
      buttonsResponseMessage: { selectedButtonId: `model_select:${modelId}` },
    },
    pushName: 'Tester',
  };
}

test('/model (model_select) routes set_llm2_model + invalidate_llm2_model to ONLY the acting account, stamped with folderPath', async () => {
  const folderA = '/tenants/ctrl-A';
  const folderB = '/tenants/ctrl-B';
  const chatId = '111@s.whatsapp.net'; // private chat -> no group metadata needed

  const ctxA = createAccountContext(folderA);
  ctxA.repos = repos;
  registry.getOrCreate(folderB); // account B exists but is NOT the acting account

  const clientA = new FakeWebSocket();
  const clientB = new FakeWebSocket();
  registry.bindClient(folderA, clientA as unknown as WebSocket);
  registry.bindClient(folderB, clientB as unknown as WebSocket);

  const sock = makeSock();

  try {
    const handled = await handleButtonResponse(
      sock as any,
      ctxA,
      makeModelSelectMsg(chatId, 'test-model') as any,
      chatId,
      OWNER_JID,
    );
    assert.equal(handled, true, 'model_select must be fully handled');

    // Account B (not acting) must receive NOTHING.
    assert.equal(clientB.sent.length, 0, "account B's client must receive no control frames");

    // Account A receives exactly the two control events, in order.
    assert.equal(clientA.sent.length, 2, "account A's client must receive both control frames");
    const frames = clientA.sent.map((s) => JSON.parse(s));

    assert.equal(frames[0].type, 'set_llm2_model');
    assert.equal(frames[0].folderPath, folderA, 'set_llm2_model must carry top-level folderPath === A');
    assert.equal(frames[0].chatId, chatId);
    assert.equal(frames[0].modelId, 'test-model');

    assert.equal(frames[1].type, 'invalidate_llm2_model');
    assert.equal(frames[1].folderPath, folderA, 'invalidate_llm2_model must carry top-level folderPath === A');
    assert.equal(frames[1].chatId, chatId);
  } finally {
    registry.unbindClient(folderA);
    registry.unbindClient(folderB);
    registry.remove(folderA);
    registry.remove(folderB);
  }
});

test('control event emitted while the account is unbound is queued, then flushed on (re)bind', async () => {
  const folderC = '/tenants/ctrl-unbound';
  const chatId = '222@s.whatsapp.net';

  const ctxC = createAccountContext(folderC);
  ctxC.repos = repos;
  registry.getOrCreate(folderC); // entry exists, but NO client bound yet

  const sock = makeSock();

  try {
    const handled = await handleButtonResponse(
      sock as any,
      ctxC,
      makeModelSelectMsg(chatId, 'queued-model') as any,
      chatId,
      OWNER_JID,
    );
    assert.equal(handled, true);

    // No client bound + non-default account => both frames queued (not dropped,
    // and not delivered to any other account's client).
    const entry = registry.get(folderC);
    assert.ok(entry, 'account C entry must exist');
    assert.equal(entry!.reliableQueue.length, 2, 'both control frames queued while unbound');

    // Reconnect: binding an OPEN client flushes the queue in FIFO order.
    const clientC = new FakeWebSocket();
    registry.bindClient(folderC, clientC as unknown as WebSocket);

    assert.equal(clientC.sent.length, 2, 'queued control frames delivered after (re)bind');
    const frames = clientC.sent.map((s) => JSON.parse(s));
    assert.equal(frames[0].type, 'set_llm2_model');
    assert.equal(frames[0].folderPath, folderC);
    assert.equal(frames[1].type, 'invalidate_llm2_model');
    assert.equal(frames[1].folderPath, folderC);
    assert.equal(registry.get(folderC)!.reliableQueue.length, 0, 'queue drained after flush');
  } finally {
    registry.unbindClient(folderC);
    registry.remove(folderC);
  }
});

test.after(() => {
  try {
    database.close();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
