// button-command-sock.test.ts — regression guard for the interactive-button
// command-dispatch bug.
//
// `handleButtonResponse` (src/wa/connection.ts) handles WhatsApp
// button / list taps. For a `/`-prefixed button id it builds a command context
// and dispatches via `handleCommandListener`. The command handlers read
// `context.sock` (e.g. handleHelp calls `context.sock.sendMessage(...)`). The
// bug: the context literal omitted `sock`, so handlers threw `undefined.send...`
// (swallowed by try/catch) and the tap silently did nothing. This test taps a
// `/help` button and asserts the reply was actually sent — proving `sock` is
// threaded into the dispatched context.
//
// Env MUST be set before importing config/db/connection (config reads env at
// import time, and db resolves its SQLite paths from `config.dataDir`).
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wazzap-btn-'));
const OWNER_JID = '15551234567@s.whatsapp.net';

process.env.DATA_DIR = TMP_DATA_DIR;
process.env.BOT_OWNER_JIDS = OWNER_JID;
process.env.REQUIRE_ACTIVATION = 'false';
process.env.LOG_LEVEL = 'silent';

import test, { before } from 'node:test';
import assert from 'node:assert/strict';

const { handleButtonResponse } = await import('../../src/wa/connection.ts');
const { createAccountContext } = await import('../../src/account/accountContext.ts');

// The command registry is populated asynchronously via auto-discovery; the
// gateway does this in bootstrap() before serving. Dispatching here (a button
// tap of `/help`) requires the registry to be initialised first.
before(async () => {
  const { initCommandRegistry } = await import(
    '../../src/wa/command/CommandRegistry.ts'
  );
  await initCommandRegistry();
  // The `/`-prefixed button is now dispatched via the auto-discovered
  // ButtonRegistry (slashButton handler), so populate it too before tapping.
  const { initButtonRegistry } = await import(
    '../../src/wa/command/ButtonRegistry.ts'
  );
  await initButtonRegistry();
});

/** Minimal fake Baileys socket that records every sendMessage call. */
function makeSock() {
  const calls: { chatId: string; content: Record<string, unknown> }[] = [];
  return {
    user: { id: 'bot@s.whatsapp.net' },
    sendMessage: async (chatId: string, content: Record<string, unknown>) => {
      calls.push({ chatId, content });
      return { key: { id: 'sent' } };
    },
    _calls: calls,
  };
}

/** Synthesize a button-response message whose selected id is a slash command. */
function makeSlashButtonMsg(chatId: string, slash: string): Record<string, unknown> {
  return {
    key: { remoteJid: chatId, fromMe: false, id: `btn_${Date.now()}` },
    message: { buttonsResponseMessage: { selectedButtonId: slash } },
    pushName: 'Tester',
  };
}

test('button tap of a /-command threads sock into the dispatched command context (regression: missing sock)', async () => {
  const folder = '/tenants/btn-A';
  const chatId = '15557654321@s.whatsapp.net'; // private chat -> no group metadata needed
  const ctx = createAccountContext(folder);
  const sock = makeSock();

  const handled = await handleButtonResponse(
    sock as unknown as Parameters<typeof handleButtonResponse>[0],
    ctx,
    makeSlashButtonMsg(chatId, '/help') as unknown as Parameters<typeof handleButtonResponse>[2],
    chatId,
    OWNER_JID,
  );

  assert.equal(handled, true, '/-prefixed button must be fully handled');
  // /help -> handleHelp does `context.sock.sendMessage(chatId, { text: HELP_TEXT })`.
  // If `sock` were missing from the dispatched context (the bug), the handler
  // would throw and swallow -> zero sends. Exactly one send proves sock was threaded.
  assert.equal(sock._calls.length, 1, 'command handler must have used context.sock to reply');
  assert.equal(sock._calls[0].chatId, chatId);
  assert.match(String(sock._calls[0].content?.text ?? ''), /Command List/);
});

test.after(() => {
  try {
    fs.rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
