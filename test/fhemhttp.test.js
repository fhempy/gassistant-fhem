'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fhemhttp = require('../lib/fhemhttp');
const { createFakeFhem } = require('./fakefhem');

test('get sends basic auth and returns body', async function () {
  const fhem = await createFakeFhem({ auth: 'user:pa:ss', answer: () => 'ok\n' });
  try {
    const url = 'http://127.0.0.1:' + fhem.port + '/fhem?cmd=list&XHR=1';
    const denied = await fhemhttp.get(url);
    assert.strictEqual(denied.statusCode, 401);
    const res = await fhemhttp.get(url, { user: 'user', pass: 'pa:ss' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body, 'ok\n');
  } finally {
    await fhem.close();
  }
});

test('get rejects on connection errors', async function () {
  await assert.rejects(fhemhttp.get('http://127.0.0.1:1/fhem'));
});

test('stream delivers chunks and calls close once', async function () {
  const server = http.createServer(function (req, res) {
    res.writeHead(200, { 'X-FHEM-csrfToken': 'abc' });
    res.write('["dev-state","on","on"]\n["dev');
    setTimeout(function () {
      res.end('-pct","5","5"]\n');
    }, 20);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    let data = '';
    let csrf;
    let closeCalls = 0;
    const err = await new Promise(function (resolve) {
      fhemhttp.stream('http://127.0.0.1:' + server.address().port + '/fhem', undefined, {
        response: (res) => { csrf = res.headers['x-fhem-csrftoken']; },
        data: (chunk) => { data += chunk; },
        close: (e) => { closeCalls++; resolve(e); }
      });
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(err, undefined);
    assert.strictEqual(closeCalls, 1);
    assert.strictEqual(csrf, 'abc');
    assert.strictEqual(data, '["dev-state","on","on"]\n["dev-pct","5","5"]\n');
  } finally {
    server.close();
  }
});

test('stream reports non 200 responses as error', async function () {
  const fhem = await createFakeFhem({ auth: 'a:b' });
  try {
    const err = await new Promise(function (resolve) {
      fhemhttp.stream('http://127.0.0.1:' + fhem.port + '/fhem?inform=1', undefined, { close: resolve });
    });
    assert.match(String(err), /HTTP 401/);
  } finally {
    await fhem.close();
  }
});
