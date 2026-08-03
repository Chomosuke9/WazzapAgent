import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveAccountOwnerLids } from '../../src/account/baileysFactory.ts';
import { createAccountContext } from '../../src/account/accountContext.ts';
import { getOrCreate, remove } from '../../src/server/accountRegistry.ts';
import { isOwnerJid } from '../../src/wa/domain/participants.ts';

test('live owner phone configuration resolves to the opaque WhatsApp LID', async () => {
  const folderPath = '/tenants/owner-phone-resolution';
  const entry = getOrCreate(folderPath);
  entry.ctx = createAccountContext(folderPath);
  entry.ctx.botOwnerJids = ['15551234567@s.whatsapp.net'];
  entry.sock = {
    signalRepository: {
      lidMapping: {
        getLIDForPN: async (jid: string) => {
          assert.equal(jid, '15551234567@s.whatsapp.net');
          return '987654321@lid';
        },
      },
    },
  } as never;

  try {
    await resolveAccountOwnerLids(folderPath);
    assert.ok(entry.ctx.botOwnerJids.includes('987654321@lid'));
    assert.equal(isOwnerJid('987654321@lid', entry.ctx.botOwnerJids), true);
  } finally {
    remove(folderPath);
  }
});
