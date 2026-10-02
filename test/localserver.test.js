'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const database = require('../lib/database');
const { createApp, getReachableDeviceIds } = require('../lib/localserver');

function fakeServerInstance() {
  const calls = [];
  return {
    calls,
    updateLocalHomeState: async (s) => calls.push(['state', s]),
    updateLocalHomeDevices: async (n) => calls.push(['devices', n])
  };
}

async function withApp(instance, fn) {
  const server = http.createServer(createApp(instance));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const post = async (body) => {
    const res = await fetch('http://127.0.0.1:' + server.address().port + '/fhemconnect/local', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body)
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    await fn(post);
  } finally {
    server.close();
  }
}

test('IDENTIFY answers as hub and sets localHome active', async function () {
  const instance = fakeServerInstance();
  await withApp(instance, async (post) => {
    const res = await post({ requestId: 'r1', inputs: [{ intent: 'action.devices.IDENTIFY', payload: { device: { mdnsScanData: {} } } }] });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.requestId, 'r1');
    assert.strictEqual(res.body.payload.device.isProxy, true);
    assert.strictEqual(res.body.payload.device.isLocalOnly, true);
    assert.deepStrictEqual(instance.calls, [['state', 'active']]);
  });
});

test('REACHABLE_DEVICES returns otherDeviceIds of the SYNC devices', async function () {
  const instance = fakeServerInstance();
  await withApp(instance, async (post) => {
    const res = await post({
      requestId: 'r2',
      inputs: [{ intent: 'action.devices.REACHABLE_DEVICES', payload: { device: { id: 'fhemconnect-id' } } }],
      devices: [
        { id: 'lamp', customData: { device: 'lamp' } },
        { id: 'lamp-scene1', customData: { device: 'lamp', scenename: 'scene1' } },
        { id: 'heater', customData: { device: 'heater' } }
      ]
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.payload.devices, [{ verificationId: 'lamp' }, { verificationId: 'heater' }]);
    assert.deepStrictEqual(instance.calls, [['state', 'active'], ['devices', 2]]);
  });
});

test('REACHABLE_DEVICES without devices in the request uses the mappings', function () {
  database.setMappings({
    'my_lamp': { XXXDEVICEDEFXXX: { name: 'my.lamp' } },
    heater: { XXXDEVICEDEFXXX: { name: 'heater' } }
  });
  try {
    assert.deepStrictEqual(getReachableDeviceIds(undefined), ['my.lamp', 'heater']);
  } finally {
    database.setMappings({});
  }
});

test('large requests are accepted', async function () {
  const devices = [];
  for (let i = 0; i < 2000; i++)
    devices.push({ id: 'device' + i, customData: { device: 'device' + i, padding: 'x'.repeat(100) } });
  await withApp(fakeServerInstance(), async (post) => {
    const res = await post({ requestId: 'r3', inputs: [{ intent: 'action.devices.REACHABLE_DEVICES' }], devices });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.payload.devices.length, 2000);
  });
});

test('invalid requests get an error response', async function () {
  await withApp(fakeServerInstance(), async (post) => {
    assert.strictEqual((await post('{invalid')).status, 400);
    assert.strictEqual((await post({})).status, 200);
  });
});
