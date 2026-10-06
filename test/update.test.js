'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const update = require('../lib/update');

// <prefix>/bin/node, <prefix>/lib/node_modules/{npm,gassistant-fhem} like a nvm installation
function fakeNode() {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'gassistant-update-'));
  const modules = path.join(prefix, 'lib', 'node_modules');
  fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(modules, 'npm', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(modules, 'gassistant-fhem'), { recursive: true });
  fs.writeFileSync(path.join(prefix, 'bin', 'node'), '');
  fs.writeFileSync(path.join(modules, 'npm', 'bin', 'npm-cli.js'), '');
  fs.writeFileSync(path.join(modules, 'gassistant-fhem', 'package.json'), '{"version":"4.0.3"}');
  return {
    execPath: path.join(prefix, 'bin', 'node'),
    cli: path.join(modules, 'npm', 'bin', 'npm-cli.js'),
    packageDir: path.join(modules, 'gassistant-fhem'),
    cleanup: () => fs.rmSync(prefix, { recursive: true, force: true })
  };
}

function fakeFhem() {
  return {
    gassistant: 'gassistant',
    commands: [],
    execute(cmd) {
      this.commands.push(cmd);
    }
  };
}

test('versions', function () {
  assert.strictEqual(update.parseVersion(''), 'latest');
  assert.strictEqual(update.parseVersion(undefined), 'latest');
  assert.strictEqual(update.parseVersion(' 4.0.3 '), '4.0.3');
  assert.strictEqual(update.parseVersion('next'), 'next');
  assert.strictEqual(update.parseVersion('1; shutdown'), undefined);
  assert.strictEqual(update.parseVersion('--registry=x'), undefined);
});

test('installs with npm of the running node and restarts via FHEM', async function (t) {
  const node = fakeNode();
  t.after(node.cleanup);
  const fhem = fakeFhem();
  let call;
  const ok = await update.update(fhem, '', {
    execPath: node.execPath,
    packageDir: node.packageDir,
    execFile: (file, args, opts, cb) => {
      call = { file, args };
      cb(null, '', '');
    }
  });
  assert.strictEqual(ok, true);
  assert.strictEqual(call.file, node.execPath);
  assert.deepStrictEqual(call.args.slice(0, 4), [node.cli, 'install', '-g', 'gassistant-fhem@latest']);
  assert.deepStrictEqual(fhem.commands, [
    'setreading gassistant gassistant-fhem-update installing gassistant-fhem@latest...',
    'setreading gassistant gassistant-fhem-update installed 4.0.3, restarting...',
    'set gassistant restart'
  ]);
});

test('reports errors without FHEM command injection and does not restart', async function (t) {
  const node = fakeNode();
  t.after(node.cleanup);
  const fhem = fakeFhem();
  const ok = await update.update(fhem, '4.0.3', {
    execPath: node.execPath,
    packageDir: node.packageDir,
    execFile: (file, args, opts, cb) => cb(new Error('exit 1'), '', 'npm error 404 Not Found; shutdown\n')
  });
  assert.strictEqual(ok, false);
  assert.ok(!fhem.commands.some((c) => c.startsWith('set gassistant restart')));
  assert.ok(fhem.commands.every((c) => !c.includes(';')), JSON.stringify(fhem.commands));
  assert.match(fhem.commands[fhem.commands.length - 1], /failed: npm error 404 Not Found/);
});

test('refuses to update an installation which is not the global one of this node', async function (t) {
  const node = fakeNode();
  t.after(node.cleanup);
  const fhem = fakeFhem();
  let called = false;
  const ok = await update.update(fhem, '', {
    execPath: node.execPath,
    packageDir: path.join(__dirname, '..'),
    execFile: () => { called = true; }
  });
  assert.strictEqual(ok, false);
  assert.strictEqual(called, false);
  assert.match(fhem.commands[0], /not a global npm installation/);
});
