// memory.test.ts — long-term memory (/memory command).
//
// Covers:
//   * SettingsRepository memory CRUD (add/list/count/delete-by-index).
//   * memory_mentions binding upsert + scoped lookup (chat preferred over global).
//   * handleMemory: add/list/delete, owner-gated global scope, char cap, and the
//     reliable invalidate_chat_settings frame.
//   * LLM-form mention capture: `/memory add ... @Name (senderRef)` persists the
//     senderRef->LID binding.
//   * renderOutboundMentions binding fallback: a COLD senderRef registry (post
//     restart) resolves a mention from the persisted LID with ZERO WhatsApp
//     metadata refetch — the anti-ban win.
//
// Env MUST be set before importing config (it reads env at import time).
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wazzap-mem-cfg-'));
process.env.LOG_LEVEL = 'silent';
process.env.REQUIRE_ACTIVATION = 'false';

import test from 'node:test';
import assert from 'node:assert/strict';

const { Database } = await import('../../src/db/Database.ts');
const { createRepositories } = await import('../../src/db/repositories/index.ts');
const { handleMemory } = await import('../../src/wa/commands/memory.ts');
const { renderStoredMentions } = await import('../../src/wa/commands/prompt.ts');
const { renderOutboundMentions } = await import('../../src/wa/outbound.ts');
const { createAccountContext } = await import('../../src/account/accountContext.ts');
const { makeSenderRef, rememberSenderRef, normalizeJid } = await import(
  '../../src/wa/domain/identifiers.ts'
);
const registry = await import('../../src/server/accountRegistry.ts');

function tmpTenant(prefix: string): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return path.join(folder, 'db');
}

function rmParent(dbDir: string): void {
  try {
    fs.rmSync(path.dirname(dbDir), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function makeCtx(overrides: Record<string, unknown>) {
  const sent: any[] = [];
  const args = (overrides.args as string) ?? '';
  const ctx: any = {
    chatId: overrides.chatId ?? 'c@g.us',
    chatType: 'group',
    senderId: 's@s.whatsapp.net',
    senderIsAdmin: false,
    senderIsOwner: overrides.senderIsOwner ?? false,
    botIsAdmin: false,
    args,
    text: args,
    contextMsgId: null,
    quotedMessageId: null,
    senderDisplay: 'Tester',
    senderRole: null,
    isGroup: true,
    fromMe: false,
    group: null,
    msg: overrides.msg ?? { key: {}, message: { conversation: args } },
    folderPath: overrides.folderPath,
    sock: { sendMessage: async (_jid: string, m: any) => { sent.push(m); } },
    repos: overrides.repos,
    account: overrides.account,
  };
  return { ctx, sent };
}

// --------------------------------------------------------------------------- //
// Repository layer
// --------------------------------------------------------------------------- //

test('memory CRUD: add / list / count / delete-by-index', () => {
  const dbDir = tmpTenant('wazzap-mem-crud-');
  const db = new Database(dbDir);
  try {
    db.open();
    const repos = createRepositories(db);
    const chat = 'c@g.us';

    assert.deepEqual(repos.settings.listMemories(chat), []);
    repos.settings.addMemory(chat, 'first');
    repos.settings.addMemory(chat, 'second');
    repos.settings.addMemory(chat, 'third');
    assert.equal(repos.settings.countMemories(chat), 3);
    assert.deepEqual(
      repos.settings.listMemories(chat).map((m) => m.text),
      ['first', 'second', 'third'],
    );

    // delete the middle entry (1-based index 2 → "second")
    assert.equal(repos.settings.deleteMemoryByIndex(chat, 2), 'second');
    assert.deepEqual(
      repos.settings.listMemories(chat).map((m) => m.text),
      ['first', 'third'],
    );
    // out-of-range and invalid indices return null (no throw)
    assert.equal(repos.settings.deleteMemoryByIndex(chat, 9), null);
    assert.equal(repos.settings.deleteMemoryByIndex(chat, 0), null);
  } finally {
    db.close();
    rmParent(dbDir);
  }
});

test('memory_mentions: upsert + scoped lookup prefers chat over global', () => {
  const dbDir = tmpTenant('wazzap-mem-bind-');
  const db = new Database(dbDir);
  try {
    db.open();
    const repos = createRepositories(db);
    repos.settings.upsertMemoryMention('c@g.us', 'abc123', '111@lid');
    repos.settings.upsertMemoryMention('__global__', 'abc123', '999@lid');

    // chat-scoped binding wins for the owning chat
    assert.equal(repos.settings.getMemoryMentionLid('c@g.us', 'abc123'), '111@lid');
    // a different chat falls back to the global binding
    assert.equal(repos.settings.getMemoryMentionLid('other@g.us', 'abc123'), '999@lid');
    // unknown senderRef → null
    assert.equal(repos.settings.getMemoryMentionLid('c@g.us', 'nope12'), null);

    // upsert replaces (does not duplicate)
    repos.settings.upsertMemoryMention('c@g.us', 'abc123', '222@lid');
    assert.equal(repos.settings.getMemoryMentionLid('c@g.us', 'abc123'), '222@lid');
  } finally {
    db.close();
    rmParent(dbDir);
  }
});

test('participant_names: upsert is idempotent, scoped per chat, latest name wins', () => {
  const dbDir = tmpTenant('wazzap-pname-');
  const db = new Database(dbDir);
  try {
    db.open();
    const repos = createRepositories(db);
    repos.settings.upsertParticipantName('c@g.us', '8wopaq', 'Andi');
    assert.equal(repos.settings.getParticipantName('c@g.us', '8wopaq'), 'Andi');
    // Scoped by chat: a different chat does not see this senderRef.
    assert.equal(repos.settings.getParticipantName('other@g.us', '8wopaq'), null);
    // Unknown senderRef → null.
    assert.equal(repos.settings.getParticipantName('c@g.us', 'nope12'), null);
    // Rename: UPSERT replaces in place (no duplicate row), latest name wins —
    // this is what lets the LLM-facing render track display-name changes.
    repos.settings.upsertParticipantName('c@g.us', '8wopaq', 'Andi Wijaya');
    assert.equal(repos.settings.getParticipantName('c@g.us', '8wopaq'), 'Andi Wijaya');
  } finally {
    db.close();
    rmParent(dbDir);
  }
});

test('renderStoredMentions swaps the baked name for the live roster name (Node twin)', () => {
  const dbDir = tmpTenant('wazzap-render-fn-');
  const db = new Database(dbDir);
  try {
    db.open();
    const repos = createRepositories(db);
    repos.settings.upsertParticipantName('c@g.us', '8wopaq', 'Andi');
    // Baked as the bare LID number at save time → now renders the live name.
    assert.equal(
      renderStoredMentions(repos.settings, 'c@g.us', '@41314028625930 (8wopaq) is dev'),
      '@Andi (8wopaq) is dev',
    );
    // Miss leaves the token untouched; `@all (all)` never matches (3-char value).
    assert.equal(
      renderStoredMentions(repos.settings, 'c@g.us', 'ping @all (all) and @x (zzzzzz)'),
      'ping @all (all) and @x (zzzzzz)',
    );
  } finally {
    db.close();
    rmParent(dbDir);
  }
});

test('handleMemory list renders stored mentions with the live name', async () => {
  const dbDir = tmpTenant('wazzap-mem-render-');
  const folderPath = '/tenants/mem-render';
  registry.getOrCreate(folderPath);
  const db = new Database(dbDir);
  try {
    db.open();
    const repos = createRepositories(db);
    // That person has spoken since → the roster holds their current name.
    repos.settings.upsertParticipantName('c@g.us', '8wopaq', 'Andi');
    // A memory saved earlier baked the bare LID number (name unknown then).
    repos.settings.addMemory('c@g.us', '@41314028625930 (8wopaq) adalah developer');

    const listed = makeCtx({ args: '', folderPath, repos });
    await handleMemory(listed.ctx);
    const listText = listed.sent.map((m) => m.text).join('\n');
    assert.ok(/@Andi \(8wopaq\)/.test(listText), 'list shows the live name');
    assert.ok(!/41314028625930/.test(listText), 'the stale bare number is gone');
  } finally {
    db.close();
    rmParent(dbDir);
  }
});

// --------------------------------------------------------------------------- //
// Command handler
// --------------------------------------------------------------------------- //

test('handleMemory add stores an entry and queues invalidate_chat_settings', async () => {
  const dbDir = tmpTenant('wazzap-mem-h-add-');
  const folderPath = '/tenants/mem-add';
  registry.getOrCreate(folderPath);
  const db = new Database(dbDir);
  try {
    db.open();
    const repos = createRepositories(db);
    const { ctx, sent } = makeCtx({ args: 'add Budi prefers tea', folderPath, repos });
    await handleMemory(ctx);

    assert.deepEqual(
      repos.settings.listMemories('c@g.us').map((m) => m.text),
      ['Budi prefers tea'],
    );
    const entry = registry.get(folderPath)!;
    const frame = entry.reliableQueue.find((f: any) => f.type === 'invalidate_chat_settings');
    assert.ok(frame, 'an invalidate_chat_settings frame must be queued');
    assert.equal((frame as any).chatId, 'c@g.us');
    assert.ok(sent.some((m) => /saved/i.test(m.text)), 'a confirmation is sent');
  } finally {
    db.close();
    rmParent(dbDir);
  }
});

test('handleMemory list + delete round-trip', async () => {
  const dbDir = tmpTenant('wazzap-mem-h-list-');
  const folderPath = '/tenants/mem-list';
  registry.getOrCreate(folderPath);
  const db = new Database(dbDir);
  try {
    db.open();
    const repos = createRepositories(db);
    repos.settings.addMemory('c@g.us', 'one');
    repos.settings.addMemory('c@g.us', 'two');

    const listed = makeCtx({ args: '', folderPath, repos });
    await handleMemory(listed.ctx);
    const listText = listed.sent.map((m) => m.text).join('\n');
    assert.ok(/one/.test(listText) && /two/.test(listText), 'list shows both entries');

    const del = makeCtx({ args: 'delete 1', folderPath, repos });
    await handleMemory(del.ctx);
    assert.deepEqual(
      repos.settings.listMemories('c@g.us').map((m) => m.text),
      ['two'],
    );
  } finally {
    db.close();
    rmParent(dbDir);
  }
});

test('handleMemory global scope is owner-gated', async () => {
  const dbDir = tmpTenant('wazzap-mem-h-glob-');
  const folderPath = '/tenants/mem-glob';
  registry.getOrCreate(folderPath);
  const db = new Database(dbDir);
  try {
    db.open();
    const repos = createRepositories(db);

    // non-owner is rejected
    const blocked = makeCtx({ args: 'global add shared secret', folderPath, repos, senderIsOwner: false });
    await handleMemory(blocked.ctx);
    assert.equal(repos.settings.countMemories('__global__'), 0);
    assert.ok(blocked.sent.some((m) => /owner/i.test(m.text)));

    // owner succeeds
    const ok = makeCtx({ args: 'global add shared fact', folderPath, repos, senderIsOwner: true });
    await handleMemory(ok.ctx);
    assert.deepEqual(
      repos.settings.listMemories('__global__').map((m) => m.text),
      ['shared fact'],
    );
  } finally {
    db.close();
    rmParent(dbDir);
  }
});

test('handleMemory rejects an over-length entry', async () => {
  const dbDir = tmpTenant('wazzap-mem-h-cap-');
  const folderPath = '/tenants/mem-cap';
  registry.getOrCreate(folderPath);
  const db = new Database(dbDir);
  try {
    db.open();
    const repos = createRepositories(db);
    const { ctx, sent } = makeCtx({ args: `add ${'x'.repeat(501)}`, folderPath, repos });
    await handleMemory(ctx);
    assert.equal(repos.settings.countMemories('c@g.us'), 0);
    assert.ok(sent.some((m) => /too long/i.test(m.text)));
  } finally {
    db.close();
    rmParent(dbDir);
  }
});

test('handleMemory captures a senderRef->LID binding from the LLM @Name (senderRef) form', async () => {
  const dbDir = tmpTenant('wazzap-mem-h-mention-');
  const folderPath = '/tenants/mem-mention';
  registry.getOrCreate(folderPath);
  const db = new Database(dbDir);
  try {
    db.open();
    const repos = createRepositories(db);
    const chatId = 'c@g.us';
    // Populate the registry as a live conversation would (sender spoke earlier).
    const account = createAccountContext('/tenants/mem-mention-acct');
    const lid = normalizeJid('555111@lid') || '555111@lid';
    const senderRef = rememberSenderRef(account, chatId, lid, lid)!;
    assert.ok(senderRef, 'precondition: senderRef registered');

    const { ctx } = makeCtx({
      args: `add Remember @Budi (${senderRef}) likes apple`,
      folderPath,
      repos,
      account,
    });
    await handleMemory(ctx);

    assert.equal(repos.settings.countMemories(chatId), 1);
    // The @Name (senderRef) token is preserved verbatim in the stored text.
    assert.match(repos.settings.listMemories(chatId)[0].text, new RegExp(`\\(${senderRef}\\)`));
    // And the stable LID behind it was persisted as a binding.
    assert.equal(repos.settings.getMemoryMentionLid(chatId, senderRef), lid);
  } finally {
    db.close();
    rmParent(dbDir);
  }
});

// --------------------------------------------------------------------------- //
// Outbound binding fallback (anti-ban: no metadata refetch on a cold registry)
// --------------------------------------------------------------------------- //

test('renderOutboundMentions resolves a mention from a persisted binding without a metadata fetch', async () => {
  const dbDir = tmpTenant('wazzap-mem-ob-');
  const db = new Database(dbDir);
  try {
    db.open();
    const repos = createRepositories(db);
    const chatId = '99887@g.us';
    const lid = normalizeJid('111222333@lid') || '111222333@lid';
    // The senderRef is the deterministic SHA1-derived ref the system would assign.
    const senderRef = makeSenderRef(chatId, lid);
    repos.settings.upsertMemoryMention(chatId, senderRef, lid);

    // Cold account context (fresh senderRef registry — simulates a restart).
    const ctx = createAccountContext('/tenants/mem-ob-cold');
    ctx.repos = repos as never;
    let metadataCalls = 0;
    ctx.sock = {
      user: { id: 'bot@s.whatsapp.net' },
      groupMetadata: async (jid: string) => {
        metadataCalls += 1;
        return { id: jid, subject: 'T', participants: [] };
      },
    } as never;

    const rendered = await renderOutboundMentions(ctx, chatId, `ping @Budi (${senderRef})`);
    assert.equal(metadataCalls, 0, 'a binding hit must NOT trigger a WhatsApp metadata fetch');
    assert.ok(
      rendered.mentions.includes(lid),
      `mention JID resolved from binding; got ${JSON.stringify(rendered.mentions)}`,
    );

    // Negative control: an unknown senderRef has no binding and DOES fall through
    // to the metadata refetch — proving the binding is what avoids the ban-risk call.
    const rendered2 = await renderOutboundMentions(ctx, chatId, 'ping @X (zzzzzz)');
    assert.ok(metadataCalls >= 1, 'no binding → metadata refetch attempted');
    assert.deepEqual(rendered2.mentions, []);
  } finally {
    db.close();
    rmParent(dbDir);
  }
});
