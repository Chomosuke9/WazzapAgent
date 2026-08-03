import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DisconnectReason } from 'baileys';
import config from '../../src/config.ts';

import {
  createOrResumeAccount,
  ensureFolderLayout,
  isStaleMessage,
  requestAccountPairingCode,
  __setQrPrinterForTests,
  __setSocketCreatorForTests,
} from '../../src/account/baileysFactory.ts';
import {
  get,
  remove,
} from '../../src/server/accountRegistry.ts';

// Step 17: the factory must run offline. We stub the Baileys socket creator so
// no version-fetch network call and no real WhatsApp socket are ever made. The
// fake exposes just enough surface for the factory to wire its
// listeners (`ev.on`) and for the shared helpers to read `user`.
type FakeEventHandler = (payload: unknown) => unknown;

class FakeSock {
  private readonly handlers = new Map<string, FakeEventHandler[]>();

  ev = {
    on: (event: string, handler: FakeEventHandler) => {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
    },
  };

  user = { id: '0@s.whatsapp.net' };
  authState = { creds: { registered: true } };
  pairingRequests: Array<{ phoneNumber: string; customCode: string | undefined }> = [];
  sentMessages: unknown[][] = [];

  emit(event: string, payload: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }

  async emitAsync(event: string, payload: unknown): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) await handler(payload);
  }

  async sendMessage(...args: unknown[]): Promise<Record<string, unknown>> {
    this.sentMessages.push(args);
    return {};
  }

  async requestPairingCode(
    phoneNumber: string,
    customCode?: string,
  ): Promise<string> {
    this.pairingRequests.push({ phoneNumber, customCode });
    return 'ABCD1234';
  }
}

function installFakeSocketCreator(): void {
  __setSocketCreatorForTests(async () => new FakeSock() as unknown as never);
}

function tmpFolder(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmrf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), message);
}

function closeUpdate(statusCode = 500): Record<string, unknown> {
  return {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode } } },
  };
}

function cleanupAccount(folder: string): void {
  get(folder)?.database?.close();
  remove(folder);
  rmrf(folder);
}

test('ensureFolderLayout creates auth/ db/ media/ stickers/ under the tenant folder', () => {
  const folder = tmpFolder('wazzap-layout-');
  try {
    const layout = ensureFolderLayout(folder);
    for (const sub of ['auth', 'db', 'media', 'stickers']) {
      const dir = path.join(folder, sub);
      assert.ok(fs.existsSync(dir), `${sub}/ should be created`);
      assert.ok(fs.statSync(dir).isDirectory(), `${sub}/ should be a directory`);
    }
    assert.equal(layout.authDir, path.join(folder, 'auth'));
    assert.equal(layout.dbDir, path.join(folder, 'db'));
    assert.equal(layout.mediaDir, path.join(folder, 'media'));
    assert.equal(layout.stickersDir, path.join(folder, 'stickers'));
  } finally {
    rmrf(folder);
  }
});

test('two distinct folderPaths -> two registry entries with distinct AccountContexts and auth dirs', async () => {
  installFakeSocketCreator();
  const folderA = tmpFolder('wazzap-acctA-');
  const folderB = tmpFolder('wazzap-acctB-');
  try {
    const entryA = await createOrResumeAccount({ folderPath: folderA, printQr: false });
    const entryB = await createOrResumeAccount({ folderPath: folderB, printQr: false });

    // Two distinct registry entries.
    assert.notStrictEqual(entryA, entryB, 'distinct folders must yield distinct entries');
    assert.strictEqual(get(folderA), entryA);
    assert.strictEqual(get(folderB), entryB);
    assert.equal(entryA.folderPath, folderA);
    assert.equal(entryB.folderPath, folderB);

    // Two distinct AccountContexts (independent per-account state).
    assert.notStrictEqual(entryA.ctx, entryB.ctx, 'each account must own its own context');
    assert.equal(entryA.ctx.folderPath, folderA);
    assert.equal(entryB.ctx.folderPath, folderB);
    assert.notStrictEqual(
      entryA.ctx.messageCache,
      entryB.ctx.messageCache,
      'per-account caches must not be shared',
    );

    // Each account got its own auth dir under its folder.
    assert.ok(fs.existsSync(path.join(folderA, 'auth')), 'account A auth dir created');
    assert.ok(fs.existsSync(path.join(folderB, 'auth')), 'account B auth dir created');

    // Sockets were created (stubbed) and bound.
    assert.ok(entryA.sock, 'account A has a bound socket');
    assert.ok(entryB.sock, 'account B has a bound socket');
    assert.notStrictEqual(entryA.sock, entryB.sock, 'distinct sockets per account');

    // The 4 tenant dirs exist for both folders.
    for (const folder of [folderA, folderB]) {
      for (const sub of ['auth', 'db', 'media', 'stickers']) {
        assert.ok(
          fs.existsSync(path.join(folder, sub)),
          `${folder}/${sub} should exist`,
        );
      }
    }
  } finally {
    remove(folderA);
    remove(folderB);
    rmrf(folderA);
    rmrf(folderB);
    __setSocketCreatorForTests(null);
  }
});

test('same folderPath again returns the SAME entry (idempotent) once a socket is live', async () => {
  installFakeSocketCreator();
  const folder = tmpFolder('wazzap-idem-');
  try {
    const first = await createOrResumeAccount({ folderPath: folder, printQr: false });
    const firstSock = first.sock;
    const firstCtx = first.ctx;

    const second = await createOrResumeAccount({ folderPath: folder, printQr: false });

    assert.strictEqual(second, first, 'same folderPath must return the same entry');
    assert.strictEqual(second.sock, firstSock, 'live socket must not be recreated');
    assert.strictEqual(second.ctx, firstCtx, 'AccountContext must be reused');
  } finally {
    remove(folder);
    rmrf(folder);
    __setSocketCreatorForTests(null);
  }
});

test('control-panel pairing waits for socket readiness and reuses one native code', async () => {
  const folder = tmpFolder('wazzap-panel-pair-');
  const fake = new FakeSock();
  fake.authState.creds.registered = false;
  __setSocketCreatorForTests(async () => fake as unknown as never);
  try {
    const first = requestAccountPairingCode(folder, '+62 812-3456-7890');
    await waitFor(() => Boolean(get(folder)?.sock), 'pairing socket should be created');

    fake.emit('connection.update', { qr: 'test-qr' });
    const result = await first;

    assert.equal(result.code, 'ABCD-1234');
    assert.equal(result.phoneNumber, '6281234567890');
    assert.deepEqual(fake.pairingRequests, [
      { phoneNumber: '6281234567890', customCode: undefined },
    ]);

    const repeated = await requestAccountPairingCode(folder, '6281234567890');
    assert.equal(repeated.code, result.code, 'recent UI refresh reuses the code');
    assert.equal(fake.pairingRequests.length, 1, 'no second native code is minted');
  } finally {
    cleanupAccount(folder);
    __setSocketCreatorForTests(null);
  }
});

test('an unregistered socket prints only its first terminal QR refresh', async () => {
  const folder = tmpFolder('wazzap-qr-once-');
  const fake = new FakeSock();
  fake.authState.creds.registered = false;
  const previousNumber = config.pairingNumber;
  const printed: string[] = [];
  config.pairingNumber = null;
  __setSocketCreatorForTests(async () => fake as unknown as never);
  __setQrPrinterForTests((qr) => printed.push(qr));
  try {
    await createOrResumeAccount({ folderPath: folder, printQr: true });
    fake.emit('connection.update', { qr: 'first-qr' });
    fake.emit('connection.update', { qr: 'second-qr' });
    assert.deepEqual(printed, ['first-qr']);
  } finally {
    config.pairingNumber = previousNumber;
    cleanupAccount(folder);
    __setQrPrinterForTests(null);
    __setSocketCreatorForTests(null);
  }
});

test('PRIVATE_CHAT_ENABLED=false drops private commands and chatbot ingress', async () => {
  installFakeSocketCreator();
  const folder = tmpFolder('wazzap-private-disabled-');
  const previous = config.privateChatEnabled;
  config.privateChatEnabled = false;
  try {
    const entry = await createOrResumeAccount({ folderPath: folder, printQr: false });
    const sock = entry.sock as unknown as FakeSock;
    await sock.emitAsync('messages.upsert', {
      type: 'notify',
      messages: [{
        key: {
          id: 'dm-disabled-1',
          remoteJid: '628123456789@s.whatsapp.net',
          fromMe: false,
        },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { conversation: '/info' },
        pushName: 'Private user',
      }],
    });

    assert.equal(sock.sentMessages.length, 0, 'private slash command must not reply');
    assert.equal(entry.ctx.messageCache.size, 0, 'private message must not reach chatbot normalization');
  } finally {
    config.privateChatEnabled = previous;
    cleanupAccount(folder);
    __setSocketCreatorForTests(null);
  }
});

test('concurrent creates for one folder share a single socket build', async () => {
  const folder = tmpFolder('wazzap-concurrent-build-');
  const gate = deferred();
  let creatorCalls = 0;
  __setSocketCreatorForTests(async () => {
    creatorCalls += 1;
    await gate.promise;
    return new FakeSock() as unknown as never;
  });

  try {
    const firstPromise = createOrResumeAccount({ folderPath: folder, printQr: false });
    const secondPromise = createOrResumeAccount({ folderPath: folder, printQr: false });

    await waitFor(() => creatorCalls > 0, 'the first socket build should start');
    gate.resolve();

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    assert.equal(creatorCalls, 1, 'only one Baileys socket may be created per tenant');
    assert.strictEqual(second, first, 'both callers receive the same account entry');
    assert.strictEqual(second.sock, first.sock, 'both callers observe the same socket');
  } finally {
    gate.resolve();
    cleanupAccount(folder);
    __setSocketCreatorForTests(null);
  }
});

test('reconnect build coalesces with create and stale close events cannot replace the new socket', async () => {
  const folder = tmpFolder('wazzap-reconnect-race-');
  const reconnectGate = deferred();
  const sockets: FakeSock[] = [];
  let creatorCalls = 0;
  let closeCallbacks = 0;

  __setSocketCreatorForTests(async () => {
    creatorCalls += 1;
    const sock = new FakeSock();
    sockets.push(sock);
    if (creatorCalls === 2) await reconnectGate.promise;
    return sock as unknown as never;
  });

  try {
    const entry = await createOrResumeAccount({
      folderPath: folder,
      printQr: false,
      onStatusChange: (status) => {
        if (status === 'close') closeCallbacks += 1;
      },
    });
    const oldSock = sockets[0]!;

    // The first close starts a replacement build and immediately makes both
    // socket references unavailable to ctx-first action helpers.
    oldSock.emit('connection.update', closeUpdate());
    await waitFor(() => creatorCalls === 2, 'the reconnect socket build should start');
    assert.equal(entry.sock, undefined);
    assert.equal(entry.ctx.sock, undefined);

    // A duplicate close from the no-longer-current socket must be ignored even
    // while its replacement is still being constructed.
    oldSock.emit('connection.update', closeUpdate());
    assert.equal(closeCallbacks, 1, 'duplicate stale close must not be forwarded');

    // A Python hello during the WhatsApp reconnect shares the same build rather
    // than creating a third socket against the tenant's auth directory.
    const duringReconnect = createOrResumeAccount({ folderPath: folder, printQr: false });
    reconnectGate.resolve();
    const resumed = await duringReconnect;
    const replacement = sockets[1]!;

    assert.equal(creatorCalls, 2, 'hello during reconnect must reuse the replacement build');
    assert.strictEqual(resumed, entry);
    assert.strictEqual(entry.sock, replacement);
    assert.strictEqual(entry.ctx.sock, replacement);

    // Once the replacement is live, a delayed close from the old generation
    // must not clear it, regress status, or initiate another reconnect.
    replacement.emit('connection.update', { connection: 'open' });
    assert.equal(entry.waStatus, 'open');
    oldSock.emit('connection.update', closeUpdate());

    assert.equal(closeCallbacks, 1);
    assert.equal(creatorCalls, 2);
    assert.strictEqual(entry.sock, replacement);
    assert.strictEqual(entry.ctx.sock, replacement);
    assert.equal(entry.waStatus, 'open');
  } finally {
    reconnectGate.resolve();
    cleanupAccount(folder);
    __setSocketCreatorForTests(null);
  }
});

test('pairing uses Baileys-generated code once and a failed initial pairing does not reconnect-loop', async () => {
  const folder = tmpFolder('wazzap-pairing-');
  const previousNumber = config.pairingNumber;
  const previousCooldown = config.pairingRetryCooldownMs;
  const sockets: FakeSock[] = [];
  let creatorCalls = 0;

  config.pairingNumber = '6281234567890';
  config.pairingRetryCooldownMs = 60_000;
  __setSocketCreatorForTests(async () => {
    creatorCalls += 1;
    const sock = new FakeSock();
    sock.authState.creds.registered = false;
    sockets.push(sock);
    return sock as unknown as never;
  });

  try {
    const entry = await createOrResumeAccount({ folderPath: folder, printQr: false });
    const sock = sockets[0]!;

    sock.emit('connection.update', { qr: 'first-qr' });
    sock.emit('connection.update', { qr: 'second-qr' });
    await waitFor(
      () => sock.pairingRequests.length === 1,
      'pairing code should be requested once',
    );
    assert.deepEqual(sock.pairingRequests, [
      { phoneNumber: '6281234567890', customCode: undefined },
    ]);

    sock.emit('connection.update', closeUpdate(428));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(creatorCalls, 1, 'initial pairing close must not auto-rebuild');
    assert.equal(entry.sock, undefined);
    assert.ok((entry.pairingRetryAfterMs ?? 0) > Date.now());

    const duringCooldown = await createOrResumeAccount({
      folderPath: folder,
      printQr: false,
    });
    assert.strictEqual(duringCooldown, entry);
    assert.equal(creatorCalls, 1, 'hello during cooldown must not bypass it');
  } finally {
    config.pairingNumber = previousNumber;
    config.pairingRetryCooldownMs = previousCooldown;
    cleanupAccount(folder);
    __setSocketCreatorForTests(null);
  }
});

test('401 during initial pairing clears only that tenant auth session', async () => {
  const folder = tmpFolder('wazzap-pairing-401-');
  const previousNumber = config.pairingNumber;
  const previousCooldown = config.pairingRetryCooldownMs;
  const sockets: FakeSock[] = [];

  config.pairingNumber = '6281234567890';
  config.pairingRetryCooldownMs = 60_000;
  __setSocketCreatorForTests(async () => {
    const sock = new FakeSock();
    sock.authState.creds.registered = false;
    sockets.push(sock);
    return sock as unknown as never;
  });

  try {
    const entry = await createOrResumeAccount({ folderPath: folder, printQr: false });
    const sock = sockets[0]!;
    const { authDir } = ensureFolderLayout(folder);
    fs.writeFileSync(path.join(authDir, 'creds.json'), '{"pairingCode":"stale"}');

    sock.emit('connection.update', { qr: 'pairing-qr' });
    await waitFor(
      () => sock.pairingRequests.length === 1,
      'pairing code should be requested once',
    );
    sock.emit('connection.update', closeUpdate(DisconnectReason.loggedOut));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(entry.sock, undefined);
    assert.deepEqual(fs.readdirSync(authDir), [], 'stale pairing auth must be removed');
    assert.ok((entry.pairingRetryAfterMs ?? 0) > Date.now());
  } finally {
    config.pairingNumber = previousNumber;
    config.pairingRetryCooldownMs = previousCooldown;
    cleanupAccount(folder);
    __setSocketCreatorForTests(null);
  }
});

test('a logged-out account clears auth so the same number can pair again', async () => {
  const folder = tmpFolder('wazzap-repair-after-logout-');
  const sockets: FakeSock[] = [];
  let creatorCalls = 0;

  __setSocketCreatorForTests(async (authState) => {
    const sock = new FakeSock();
    // Simulate a previously linked first socket, then let the replacement
    // reflect the auth state loaded from disk after logout cleanup.
    sock.authState.creds.registered = creatorCalls === 0
      ? true
      : Boolean(authState.creds.registered);
    creatorCalls += 1;
    sockets.push(sock);
    return sock as unknown as never;
  });

  try {
    const entry = await createOrResumeAccount({ folderPath: folder, printQr: false });
    const first = sockets[0]!;
    const { authDir } = ensureFolderLayout(folder);
    fs.writeFileSync(path.join(authDir, 'creds.json'), '{}');

    first.emit('connection.update', closeUpdate(DisconnectReason.loggedOut));
    assert.equal(entry.sock, undefined);
    assert.deepEqual(fs.readdirSync(authDir), [], 'logged-out auth files must be removed');

    const pairing = requestAccountPairingCode(folder, '6281234567890');
    await waitFor(() => sockets.length === 2, 'pairing should build a fresh socket');
    const second = sockets[1]!;
    second.emit('connection.update', { qr: 'fresh-qr' });
    const result = await pairing;

    assert.equal(result.phoneNumber, '6281234567890');
    assert.deepEqual(second.pairingRequests, [
      { phoneNumber: '6281234567890', customCode: undefined },
    ]);
  } finally {
    cleanupAccount(folder);
    __setSocketCreatorForTests(null);
  }
});

// ---------------------------------------------------------------------------
// Stale-message gate: WhatsApp flushes the offline backlog through
// messages.upsert on reconnect. isStaleMessage drops anything older than
// config.staleMessageMaxAgeMs (default 5000ms) so the bot ignores that backlog.
// messageTimestamp is in SECONDS (Baileys), so the helper multiplies by 1000.
// ---------------------------------------------------------------------------

// A 5s threshold (config default) anchored at a fixed "now" for deterministic
// math: nowMs = 1_000_000ms == second 1000.
const NOW_MS = 1_000_000;

function msgAtSecond(second: number | null): { messageTimestamp?: number } {
  return second === null ? {} : { messageTimestamp: second };
}

test('isStaleMessage: a just-arrived message is NOT stale', () => {
  assert.equal(isStaleMessage(msgAtSecond(1000) as never, NOW_MS), false);
});

test('isStaleMessage: a message 10s old IS stale (dropped)', () => {
  assert.equal(isStaleMessage(msgAtSecond(990) as never, NOW_MS), true);
});

test('isStaleMessage: exactly at the 5s threshold is NOT stale (strict >)', () => {
  // diff == 5000ms, not > 5000ms.
  assert.equal(isStaleMessage(msgAtSecond(995) as never, NOW_MS), false);
});

test('isStaleMessage: just past the 5s threshold IS stale', () => {
  // diff == 6000ms.
  assert.equal(isStaleMessage(msgAtSecond(994) as never, NOW_MS), true);
});

test('isStaleMessage: missing/zero timestamp fails OPEN (kept, not stale)', () => {
  assert.equal(isStaleMessage(msgAtSecond(null) as never, NOW_MS), false);
  assert.equal(isStaleMessage(msgAtSecond(0) as never, NOW_MS), false);
});
