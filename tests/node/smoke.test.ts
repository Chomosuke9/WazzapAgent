import test from 'node:test';
import assert from 'node:assert/strict';
import { add } from './helpers/smokeHelper.ts';

// Proves the TS test path works: the runner loads this .ts file via tsx,
// resolves the imported .ts helper, and executes the assertion.
test('smoke: tsx loader resolves TypeScript and helper runs', () => {
  assert.equal(add(1, 1), 2);
});
