import test from 'node:test';
import assert from 'node:assert/strict';

process.env.REQUIRE_ACTIVATION = 'false';

import { joinErrorMessage } from '../../src/wa/command/join.js';

test('/join maps not-authorized to a friendly message (feature 7)', () => {
  const msg = joinErrorMessage({ message: 'not-authorized' });
  assert.match(msg, /tidak diizinkan|ditambahkan/i);
  assert.doesNotMatch(msg, /not-authorized/);
});

test('/join maps gone/404 to invalid-link message', () => {
  assert.match(joinErrorMessage({ message: 'gone' }), /link tidak valid|direset/i);
  assert.match(joinErrorMessage({ output: { statusCode: 404 } }), /link tidak valid|direset/i);
});

test('/join maps conflict to already-in-group message', () => {
  assert.match(joinErrorMessage({ message: 'conflict' }), /sudah berada/i);
  assert.match(joinErrorMessage({ output: { statusCode: 409 } }), /sudah berada/i);
});

test('/join maps rate-overlimit/429 to rate-limit message', () => {
  assert.match(joinErrorMessage({ message: 'rate-overlimit' }), /terlalu banyak|coba lagi/i);
  assert.match(joinErrorMessage({ output: { statusCode: 429 } }), /terlalu banyak|coba lagi/i);
});

test('/join maps timeout to timeout message', () => {
  assert.match(joinErrorMessage({ message: 'request timed out' }), /waktu permintaan habis|timeout/i);
});

test('/join falls back generically without leaking raw error', () => {
  const msg = joinErrorMessage({ message: 'some-weird-internal-token-xyz' });
  assert.match(msg, /Gagal masuk grup/i);
  assert.doesNotMatch(msg, /some-weird-internal-token-xyz/);
});

test('/join reads Boom payload message shape', () => {
  const msg = joinErrorMessage({ output: { payload: { message: 'not-authorized' } } });
  assert.match(msg, /tidak diizinkan|ditambahkan/i);
});
