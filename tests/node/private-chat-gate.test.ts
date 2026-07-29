import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../../src/config.ts';
import { shouldIgnorePrivateChat } from '../../src/wa/privateChat.ts';

test('private chat gate defaults to allowing private messages', () => {
  const previous = config.privateChatEnabled;
  try {
    config.privateChatEnabled = true;
    assert.equal(shouldIgnorePrivateChat('628123456789@s.whatsapp.net'), false);
    assert.equal(shouldIgnorePrivateChat('120363000000000000@g.us'), false);
  } finally {
    config.privateChatEnabled = previous;
  }
});

test('private chat gate ignores DMs but keeps groups active when disabled', () => {
  const previous = config.privateChatEnabled;
  try {
    config.privateChatEnabled = false;
    assert.equal(shouldIgnorePrivateChat('628123456789@s.whatsapp.net'), true);
    assert.equal(shouldIgnorePrivateChat('628123456789@lid'), true);
    assert.equal(shouldIgnorePrivateChat('120363000000000000@g.us'), false);
  } finally {
    config.privateChatEnabled = previous;
  }
});
