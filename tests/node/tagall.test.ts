import test from 'node:test';
import assert from 'node:assert/strict';

process.env.REQUIRE_ACTIVATION = 'false';

import { extractNonJidMentions } from '../../src/wa/domain/messageParser.js';
import { VALID_TRIGGERS } from '../../src/db/repositories/SettingsRepository.js';

test('extractNonJidMentions reads contextInfo.nonJidMentions (feature 2)', () => {
  const tagAllMsg: any = { extendedTextMessage: { text: '@all hello', contextInfo: { nonJidMentions: 3 } } };
  assert.equal(extractNonJidMentions(tagAllMsg), 3);

  const normalMsg: any = { extendedTextMessage: { text: 'hi', contextInfo: { mentionedJid: ['x@s.whatsapp.net'] } } };
  assert.equal(extractNonJidMentions(normalMsg), 0);

  const plain: any = { conversation: 'hi' };
  assert.equal(extractNonJidMentions(plain), 0);
});

test('tagall is a valid trigger but not a default trigger', () => {
  assert.ok(VALID_TRIGGERS.has('tagall'), 'tagall must be a valid trigger');
  assert.ok(VALID_TRIGGERS.has('tag'), 'tag still valid');
});
