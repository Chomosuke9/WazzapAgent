import test from 'node:test';
import assert from 'node:assert/strict';

process.env.REQUIRE_ACTIVATION = 'false';

import { joinErrorMessage } from '../../src/wa/commands/join.js';

test('/join maps not-authorized to a friendly message (feature 7)', () => {
  const msg = joinErrorMessage({ message: 'not-authorized' });
  assert.match(msg, /not allowed|add the bot/i);
  assert.doesNotMatch(msg, /not-authorized/);
});

test('/join maps gone/404 to invalid-link message', () => {
  assert.match(joinErrorMessage({ message: 'gone' }), /invalid or has been reset/i);
  assert.match(joinErrorMessage({ output: { statusCode: 404 } }), /invalid or has been reset/i);
});

test('/join maps conflict to already-in-group message', () => {
  assert.match(joinErrorMessage({ message: 'conflict' }), /already in this group/i);
  assert.match(joinErrorMessage({ output: { statusCode: 409 } }), /already in this group/i);
});

test('/join maps rate-overlimit/429 to rate-limit message', () => {
  assert.match(joinErrorMessage({ message: 'rate-overlimit' }), /too many|try again/i);
  assert.match(joinErrorMessage({ output: { statusCode: 429 } }), /too many|try again/i);
});

test('/join maps timeout to timeout message', () => {
  assert.match(joinErrorMessage({ message: 'request timed out' }), /timed out|timeout/i);
});

test('/join falls back generically without leaking raw error', () => {
  const msg = joinErrorMessage({ message: 'some-weird-internal-token-xyz' });
  assert.match(msg, /Failed to join the group/i);
  assert.doesNotMatch(msg, /some-weird-internal-token-xyz/);
});

test('/join reads Boom payload message shape', () => {
  const msg = joinErrorMessage({ output: { payload: { message: 'not-authorized' } } });
  assert.match(msg, /not allowed|add the bot/i);
});
