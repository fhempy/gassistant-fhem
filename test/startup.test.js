'use strict';

// Starts the client against a simulated FHEM without refresh token. The client must
// detect the gassistant device and request a login, which works without the cloud backend.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createFakeFhem } = require('./fakefhem');

test('client starts and requests login', { timeout: 30000 }, async function () {
  const fhem = await createFakeFhem({
    auth: 'fhemuser:fhem:pass',
    answer: function (cmd) {
      if (cmd === 'jsonlist2 TYPE=gassistant')
        return JSON.stringify({ Results: [{ Name: 'ga' }], totalResultsReturned: 1 });
      if (cmd === 'get ga refreshToken')
        return '';
      return '';
    }
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gassistant-fhem-'));
  const config = {
    connections: [{
      name: 'FHEM', server: '127.0.0.1', port: String(fhem.port), webname: 'fhem',
      filter: 'room=GoogleAssistant', auth: { user: 'fhemuser', pass: 'fhem:pass' }
    }]
  };
  fs.mkdirSync(path.join(home, '.fhemconnect'));
  fs.writeFileSync(path.join(home, '.fhemconnect', 'gassistant-fhem.cfg'), JSON.stringify(config));

  // start the CLI directly, bin/gassistant-fhem would refuse to start if a real client is running
  const cli = path.join(__dirname, '..', 'lib', 'cli');
  const child = spawn(process.execPath, ['-e', 'require(' + JSON.stringify(cli) + ')()'], {
    env: Object.assign({}, process.env, { HOME: home })
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  try {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !fhem.commands.some((c) => c.cmd.includes('login required')))
      await new Promise((r) => setTimeout(r, 100));

    const cmds = fhem.commands.map((c) => c.cmd);
    assert.ok(cmds.includes('jsonlist2 TYPE=gassistant'), output);
    assert.ok(cmds.includes('get ga refreshToken'), output);
    const login = cmds.find((c) => c.startsWith('setreading ga gassistant-fhem-connection login required; set ga loginURL https://fhemconnector.eu.auth0.com/authorize?'));
    assert.ok(login, output);
    assert.ok(fhem.commands.every((c) => c.csrf === 'csrf123'), 'csrf token is sent');
    assert.ok(!output.includes('fhem:pass'), 'password is not logged');

    // graceful shutdown sets the connection reading
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
    assert.ok(fhem.commands.some((c) => c.cmd === 'setreading ga gassistant-fhem-connection disconnected'), output);
  } finally {
    child.kill('SIGKILL');
    await fhem.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
