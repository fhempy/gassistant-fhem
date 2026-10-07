'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sync = require('../lib/sync');

function setup(opts) {
  opts = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gassistant-sync-'));
  const ctx = {
    dir: dir,
    file: path.join(dir, 'sub', 'gassistant-fhem-sync.json'),
    requests: 0,
    ok: true,
    uid: 'uid1'
  };
  ctx.create = function () {
    return sync.createSync({
      request: async function () {
        ctx.requests++;
        return ctx.ok;
      },
      uid: function () { return ctx.uid; },
      stateFile: opts.memory ? undefined : ctx.file
    });
  };
  ctx.cleanup = function () {
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return ctx;
}

const MAPPINGS = { lamp: { XXXDEVICEDEFXXX: { name: 'lamp', ghomeName: 'Lampe', mappings: { On: { reading: 'state' } } } } };

test('hash ignores the key order', function () {
  const a = { b: 1, a: { d: [1, { y: 2, x: 1 }], c: 'x' } };
  const b = { a: { c: 'x', d: [1, { x: 1, y: 2 }] }, b: 1 };
  assert.strictEqual(sync.devicesHash('u', a), sync.devicesHash('u', b));
  assert.notStrictEqual(sync.devicesHash('u', a), sync.devicesHash('other', a));
  assert.notStrictEqual(sync.devicesHash('u', a), sync.devicesHash('u', { b: 2, a: a.a }));
});

test('SYNC only if the devices changed, also after a restart', async function () {
  const ctx = setup();
  try {
    let s = ctx.create();
    s.setMappings(MAPPINGS);
    assert.strictEqual(await s.requestSync(), true);
    assert.strictEqual(ctx.requests, 1);

    // reconnect with the same devices
    s.setMappings(JSON.parse(JSON.stringify(MAPPINGS)));
    assert.strictEqual(await s.requestSync(), false);

    // restart of the client
    s = ctx.create();
    s.setMappings(JSON.parse(JSON.stringify(MAPPINGS)));
    assert.strictEqual(await s.requestSync(), false);
    assert.strictEqual(ctx.requests, 1);

    // renamed device
    const renamed = JSON.parse(JSON.stringify(MAPPINGS));
    renamed.lamp.XXXDEVICEDEFXXX.ghomeName = 'Stehlampe';
    s.setMappings(renamed);
    assert.strictEqual(await s.requestSync(), true);
    assert.strictEqual(ctx.requests, 2);

    // removed all devices
    s.setMappings({});
    assert.strictEqual(await s.requestSync(), true);
    assert.strictEqual(ctx.requests, 3);
  } finally {
    ctx.cleanup();
  }
});

test('other account SYNCs', async function () {
  const ctx = setup();
  try {
    const s = ctx.create();
    s.setMappings(MAPPINGS);
    await s.requestSync();
    ctx.uid = 'uid2';
    assert.strictEqual(await s.requestSync(), true);
    assert.strictEqual(ctx.requests, 2);
  } finally {
    ctx.cleanup();
  }
});

test('forced SYNC (reload, server upgrade)', async function () {
  const ctx = setup();
  try {
    const s = ctx.create();
    s.setMappings(MAPPINGS);
    await s.requestSync();
    s.forceNext();
    assert.strictEqual(await s.requestSync(), true);
    // only once
    assert.strictEqual(await s.requestSync(), false);
    assert.strictEqual(ctx.requests, 2);
  } finally {
    ctx.cleanup();
  }
});

test('failed SYNC request is repeated', async function () {
  const ctx = setup();
  try {
    const s = ctx.create();
    s.setMappings(MAPPINGS);
    ctx.ok = false;
    await s.requestSync();
    ctx.ok = true;
    assert.strictEqual(await s.requestSync(), true);
    assert.strictEqual(await s.requestSync(), false);
    assert.strictEqual(ctx.requests, 2);
  } finally {
    ctx.cleanup();
  }
});

test('no SYNC if generating the mappings failed', async function () {
  const ctx = setup();
  try {
    const s = ctx.create();
    s.setMappings(undefined);
    assert.strictEqual(await s.requestSync(), false);
    assert.strictEqual(ctx.requests, 0);
  } finally {
    ctx.cleanup();
  }
});

test('SYNC again after MAX_AGE', async function (t) {
  const ctx = setup();
  try {
    let now = 1000000;
    t.mock.method(Date, 'now', function () { return now; });
    const s = ctx.create();
    s.setMappings(MAPPINGS);
    await s.requestSync();
    now += sync.MAX_AGE - 1;
    assert.strictEqual(await s.requestSync(), false);
    now += 2;
    assert.strictEqual(await s.requestSync(), true);
    assert.strictEqual(ctx.requests, 2);
  } finally {
    ctx.cleanup();
  }
});

test('state file not writable: state kept in memory', async function () {
  const ctx = setup();
  try {
    // a directory where the file should be
    fs.mkdirSync(ctx.file, { recursive: true });
    const s = ctx.create();
    s.setMappings(MAPPINGS);
    assert.strictEqual(await s.requestSync(), true);
    assert.strictEqual(await s.requestSync(), false);
  } finally {
    ctx.cleanup();
  }
});
