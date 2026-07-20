import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createOrResumeAccount,
  ensureFolderLayout,
  isStaleMessage,
  __setSocketCreatorForTests,
} from '../../src/account/baileysFactory.ts';
import {
  get,
  remove,
} from '../../src/server/accountRegistry.ts';

// Step 17: the factory must run offline. We stub the Baileys socket creator so
// no `fetchLatestBaileysVersion` network call and no real WhatsApp socket are
// ever made. The fake exposes just enough surface for the factory to wire its
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

  emit(event: string, payload: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }

  async sendMessage(): Promise<Record<string, unknown>> {
    return {};
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
