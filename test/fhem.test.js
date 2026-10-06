'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseAuth, redact, reportStateWithData, flushReportState } = require('../lib/fhem');
const database = require('../lib/database');
const { configForLog } = require('../lib/server');

test('parseAuth keeps colons in the password', function () {
  assert.deepStrictEqual(parseAuth('user:pa:ss'), { user: 'user', pass: 'pa:ss' });
  assert.deepStrictEqual(parseAuth('user:'), { user: 'user', pass: '' });
  assert.strictEqual(parseAuth('nopassword'), undefined);
  assert.strictEqual(parseAuth(':pass'), undefined);
});

test('redact hides refresh tokens in urls', function () {
  const url = 'http://fhem:8083/fhem?cmd=' + encodeURIComponent('set ga refreshToken SECRET') + '&XHR=1';
  assert.ok(!redact(url).includes('SECRET'));
  assert.ok(redact(url).includes('XHR=1'));
});

test('configForLog masks credentials without changing the config', function () {
  const config = {
    auth: { user: 'a', pass: 'b' },
    connections: [{ name: 'FHEM', auth: { user: 'c', pass: 'd' } }]
  };
  const logConfig = configForLog(config);
  assert.strictEqual(logConfig.auth, 'auth used');
  assert.strictEqual(logConfig.connections[0].auth, 'auth used');
  assert.deepStrictEqual(config.connections[0].auth, { user: 'c', pass: 'd' });
  assert.deepStrictEqual(config.auth, { user: 'a', pass: 'b' });
});

test('report state sends changes together and skips unchanged states', async function (t) {
  const sent = [];
  t.mock.method(database, 'reportStateWithData', async function (data) {
    sent.push(data.payload.devices.states);
    return {};
  });
  const report = (id, state) => reportStateWithData({ payload: { devices: { states: { [id]: state } } } });

  report('lamp', { on: true, online: true });
  report('heater', { thermostatTemperatureAmbient: 21 });
  await flushReportState();
  assert.deepStrictEqual(sent, [{ lamp: { on: true, online: true }, heater: { thermostatTemperatureAmbient: 21 } }]);

  // unchanged
  report('lamp', { on: true, online: true });
  await flushReportState();
  assert.strictEqual(sent.length, 1);

  // changed and back again before it was sent
  report('lamp', { on: false, online: true });
  report('lamp', { on: true, online: true });
  await flushReportState();
  assert.strictEqual(sent.length, 1);

  report('lamp', { on: false, online: true });
  await flushReportState();
  assert.deepStrictEqual(sent[1], { lamp: { on: false, online: true } });
});
