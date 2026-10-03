'use strict';

const test = require('node:test');
const assert = require('node:assert');
const utils = require('../lib/utils');

test('cached2Format converts readings', async function () {
  const temp = { reading: ['temperature'], minStep: 0.5 };
  assert.strictEqual(await utils.cached2Format('uid', temp, { temperature: '21.3' }), 21.5);

  const onoff = { reading: ['state'], format: 'bool', valueOn: 'on' };
  assert.strictEqual(await utils.cached2Format('uid', onoff, { state: 'on' }), true);
  assert.strictEqual(await utils.cached2Format('uid', onoff, { state: 'off' }), false);

  const pct = { reading: ['pct'], format: 'int', invert: true };
  assert.strictEqual(await utils.cached2Format('uid', pct, { pct: '30' }), 70);
});

test('cached2Format evaluates reading2homekit functions from the server', async function () {
  const database = require('../lib/database');
  database.setMappings({
    lamp: {
      XXXDEVICEDEFXXX: {
        name: 'lamp',
        mappings: {
          On: { reading: ['state'], reading2homekit: 'function (mapping, orig) { return orig === "an"; }' }
        }
      }
    }
  });
  const dev = utils.getDeviceAndReadings('uid', 'lamp');
  assert.strictEqual(typeof dev.device.mappings.On.reading2homekit, 'function');
  assert.strictEqual(await utils.cached2Format('uid', dev.device.mappings.On, { state: 'an' }), true);
  assert.ok(!('mapping' in global), 'no global leak');
});

test('cached2Format ignores missing readings for reading2homekit functions', async function () {
  const errors = [];
  const origError = console.error;
  console.error = (msg) => errors.push(String(msg));
  try {
    // e.g. MQTT2_DEVICE with "set color" but without reading "color"
    const rgb = { reading: ['color'], reading2homekit: function (mapping, orig) { return parseInt('0x' + orig); } };
    assert.strictEqual(await utils.cached2Format('uid', rgb, { state: 'on' }), undefined);
    assert.strictEqual(await utils.cached2Format('uid', rgb, { color: 'ff0000' }), 0xff0000);
    rgb.default = 0;
    assert.strictEqual(await utils.cached2Format('uid', rgb, { state: 'on' }), 0);
  } finally {
    console.error = origError;
  }
  assert.deepStrictEqual(errors, [], 'no error is logged');
});
