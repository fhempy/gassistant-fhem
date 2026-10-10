'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { retry } = require('../lib/retry');

test('retries temporary errors with increasing delay', async function (t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const delays = [];
  const p = retry(async function () {
    calls++;
    if (calls < 5)
      throw new Error('auth/network-request-failed');
    return 'ok';
  }, { min: 10, max: 40, onRetry: (err, delay) => delays.push(delay) });
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(40);
  }
  assert.strictEqual(await p, 'ok');
  assert.strictEqual(calls, 5);
  assert.deepStrictEqual(delays, [10, 20, 40, 40]);
});

test('permanent errors are thrown immediately', async function () {
  let calls = 0;
  const err = new Error('Invalid refresh token: invalid_grant');
  err.permanent = true;
  await assert.rejects(retry(async function () {
    calls++;
    throw err;
  }, { min: 10, max: 40 }), /invalid_grant/);
  assert.strictEqual(calls, 1);
});
