'use strict';

// Update of gassistant-fhem from FHEM: "trigger gassistant update: latest"
// (or "set gassistant update [version]" with a 39_gassistant.pm which supports it).
//
// npm of the running Node.js installation is used (also nvm installations, where npm is not
// in the PATH of FHEM). Afterwards gassistant-fhem is restarted by FHEM ("set <gassistant> restart").

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const log = require('./logger')._system;

const PACKAGE = 'gassistant-fhem';
const READING = 'gassistant-fhem-update';
const INSTALL_TIMEOUT = 10 * 60 * 1000;

var running = false;

// npm-cli.js of the running Node.js installation
function npmCli(execPath) {
  var bin = path.dirname(execPath || process.execPath);
  var candidates = [
    path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // Linux, macOS, nvm
    path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js') // Windows
  ];
  return candidates.find(function (p) {
    return fs.existsSync(p);
  });
}

// global node_modules directory belonging to npm-cli.js
function globalModules(cli) {
  // <prefix>/lib/node_modules/npm/bin/npm-cli.js -> <prefix>/lib/node_modules
  return path.resolve(cli, '..', '..', '..');
}

// only update a global installation of this Node.js, otherwise the restart would start the old version
function installedGlobally(cli, packageDir) {
  var expected = path.join(globalModules(cli), PACKAGE);
  try {
    return fs.realpathSync(packageDir) === fs.realpathSync(expected);
  } catch (err) {
    return false;
  }
}

// "", "latest", "4.0.3"
function parseVersion(value) {
  var version = String(value === undefined || value === null ? '' : value).trim() || 'latest';
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version))
    return undefined;
  return version;
}

function lastLine(text) {
  var lines = String(text || '').split('\n').map(function (l) {
    return l.trim();
  }).filter(function (l) {
    return l && !/^npm (notice|warn)/i.test(l);
  });
  return lines.length ? lines[lines.length - 1] : '';
}

function installedVersion(cli) {
  try {
    var pkg = path.join(globalModules(cli), PACKAGE, 'package.json');
    return JSON.parse(fs.readFileSync(pkg, 'utf8')).version;
  } catch (err) {
    return undefined;
  }
}

// fhem: FHEM instance (execute, gassistant), value: version, empty for latest
function update(fhem, value, options) {
  options = options || {};
  var run = options.execFile || execFile;
  var packageDir = options.packageDir || path.join(__dirname, '..');
  var execPath = options.execPath || process.execPath;

  function status(text) {
    log.info('update: ' + text);
    // ";" separates FHEM commands
    var safeText = String(text).replace(/[;\r\n]+/g, ' ');
    fhem.execute('setreading ' + fhem.gassistant + ' ' + READING + ' ' + safeText);
  }

  var version = parseVersion(value);
  if (!version) {
    status('invalid version, use: update [version]');
    return Promise.resolve(false);
  }
  if (running) {
    status('update already running');
    return Promise.resolve(false);
  }

  var cli = npmCli(execPath);
  if (!cli) {
    status('failed: npm not found for ' + execPath);
    return Promise.resolve(false);
  }
  if (!installedGlobally(cli, packageDir)) {
    status('failed: ' + packageDir + ' is not a global npm installation of ' + execPath);
    return Promise.resolve(false);
  }

  running = true;
  status('installing ' + PACKAGE + '@' + version + '...');

  return new Promise(function (resolve) {
    run(execPath, [cli, 'install', '-g', PACKAGE + '@' + version, '--no-audit', '--no-fund'], {
      timeout: INSTALL_TIMEOUT,
      maxBuffer: 10 * 1024 * 1024,
      env: Object.assign({}, process.env, { NODE_ENV: 'production' })
    }, function (err, stdout, stderr) {
      running = false;
      if (err) {
        log.error('update failed: ' + err + '\n' + stdout + '\n' + stderr);
        var reason = lastLine(stderr) || String(err.message || err);
        if (/EACCES|permission denied/i.test(stderr || ''))
          reason = 'no write permission for ' + globalModules(cli) + ', update manually as root: npm install -g ' + PACKAGE;
        status('failed: ' + reason);
        resolve(false);
        return;
      }
      status('installed ' + (installedVersion(cli) || version) + ', restarting...');
      // FHEM (CoProcess) stops this process and starts the new version
      fhem.execute('set ' + fhem.gassistant + ' restart');
      resolve(true);
    });
  });
}

module.exports = {
  update,
  parseVersion,
  npmCli,
  installedGlobally
};
