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
