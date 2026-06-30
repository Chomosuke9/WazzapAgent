import test from 'node:test';
import assert from 'node:assert/strict';

process.env.REQUIRE_ACTIVATION = 'false';

import { handleGenerate } from '../../src/wa/commands/generate.js';

interface Captured {
  textMessages: Record<string, unknown>[];
  relayed: Record<string, unknown>[];
  gen: { type: string; days: number } | null;
}

function makeCtx(captured: Captured, msgId: string = 'A'.repeat(32), compatMode: string = 'auto') {
  const sock: {
    user: { id: string; name: string };
    sendMessage: (jid: string, content: Record<string, unknown>) => Promise<{ key: { id: string } }>;
    relayMessage: (jid: string, message: Record<string, unknown>) => void;
  } = {
    user: { id: '123:1@s.whatsapp.net', name: 'TestBot' },
    sendMessage: async (_jid: string, content: Record<string, unknown>) => {
      captured.textMessages.push(content);
      return { key: { id: 'm1' } };
    },
    relayMessage: async (_jid: string, message: Record<string, unknown>) => {
      captured.relayed.push(message);
    },
  };
  const repos: {
    activation: {
      generateActivationCode: (type: string, days: number) => { code: string };
    };
    settings: {
      getCompatibilityMode: (chatId: string) => string;
    };
  } = {
    activation: {
      generateActivationCode: (type: string, days: number) => {
        captured.gen = { type, days };
        return { code: 'WA-ABCD1234' };
      },
    },
    settings: {
      getCompatibilityMode: (_chatId: string) => compatMode,
    },
  };
  return {
    chatId: '12345@g.us',
    chatType: 'group',
    senderId: 'owner@s.whatsapp.net',
    senderIsAdmin: true,
    senderIsOwner: true,
    botIsAdmin: true,
    args: 'group 30',
    text: 'group 30',
    contextMsgId: null,
    quotedMessageId: null,
    senderDisplay: 'Owner',
    senderRole: null,
    isGroup: true,
    fromMe: false,
    group: null,
    msg: { key: { id: msgId } } as Record<string, unknown>,
    folderPath: '/data',
    sock,
    repos,
  } as Record<string, unknown>;
}

function findCopyCode(message: Record<string, unknown>): string | null {
  const buttons = message?.viewOnceMessage?.message?.interactiveMessage?.nativeFlowMessage?.buttons;
  if (!Array.isArray(buttons)) return null;
  for (const b of buttons) {
    if (b.name === 'cta_copy') {
      try {
        const params = JSON.parse(b.buttonParamsJson);
        return params.copy_code ?? null;
      } catch { return null; }
    }
  }
  return null;
}

test('/generate sends a cta_copy button carrying "/activate <code>" (feature 4)', async () => {
  const captured = { textMessages: [] as Record<string, unknown>[], relayed: [] as Record<string, unknown>[], gen: null as { type: string; days: number } | null };
  await handleGenerate(makeCtx(captured));

  assert.equal(captured.relayed.length, 1, 'should relay one interactive message');
  const copyCode = findCopyCode(captured.relayed[0]);
  assert.equal(copyCode, '/activate WA-ABCD1234');
  assert.deepEqual(captured.gen, { type: 'group', days: 30 });
});

test('/generate falls back to a monospace code block for safe-tier callers (web)', async () => {
  const captured: Captured = { textMessages: [], relayed: [], gen: null };
  // A web message id ("3E" + 20 chars) maps to the safe tier — no cta_copy.
  await handleGenerate(makeCtx(captured, '3E' + 'B'.repeat(20)));

  assert.equal(captured.relayed.length, 0, 'no interactive message relayed on safe tier');
  const sent = captured.textMessages.map((m) => m.text || '').join('\n');
  assert.match(sent, /\/activate WA-ABCD1234/);
  assert.ok(sent.includes('```'), 'activation code is sent in a monospace block');
});

test('/generate rejects invalid type', async () => {
  const captured: Captured = { textMessages: [], relayed: [], gen: null };
  const ctx = makeCtx(captured);
  ctx.args = 'bogus 10';
  await handleGenerate(ctx);
  assert.equal(captured.relayed.length, 0);
  assert.ok(captured.textMessages.some((m) => /Type must be/i.test(m.text || '')));
});

test('explicit compat=safe forces the monospace fallback even for an interactive caller', async () => {
  const captured: Captured = { textMessages: [], relayed: [], gen: null };
  // 'A'*32 maps to an interactive-capable tier, but compat=safe must win.
  await handleGenerate(makeCtx(captured, 'A'.repeat(32), 'safe'));
  assert.equal(captured.relayed.length, 0, 'safe compat suppresses the cta_copy button');
  const sent = captured.textMessages.map((m) => m.text || '').join('\n');
  assert.match(sent, /\/activate WA-ABCD1234/);
  assert.ok(sent.includes('```'), 'activation code is sent in a monospace block');
});

test('explicit compat=full sends the cta_copy button even for a web caller', async () => {
  const captured: Captured = { textMessages: [], relayed: [], gen: null };
  // A web message id would be safe under auto, but compat=full must win.
  await handleGenerate(makeCtx(captured, '3E' + 'B'.repeat(20), 'full'));
  assert.equal(captured.relayed.length, 1, 'full compat keeps the cta_copy button');
  assert.equal(findCopyCode(captured.relayed[0]), '/activate WA-ABCD1234');
});
