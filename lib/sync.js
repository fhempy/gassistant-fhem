'use strict';

// Google SYNC (api/initsync) only if the devices sent to Google changed.
//
// The SYNC response of the server is created from the device mappings of api/3.0/genmappings.
// The hash of these mappings (and the uid) of the last successful SYNC request is stored in
// ~/.fhemconnect, a restart or reconnect with unchanged devices doesn't request a SYNC.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const log = require('./logger')._system;

const STATE_FILE = 'gassistant-fhem-sync.json';
// SYNC again after a week even without changes, in case a SYNC got lost
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;

// JSON with sorted keys, the order of the keys doesn't change the hash
function stableStringify(value) {
  if (Array.isArray(value))
    return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().filter(function (k) {
      return value[k] !== undefined;
    }).map(function (k) {
      return JSON.stringify(k) + ':' + stableStringify(value[k]);
    }).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

function devicesHash(uid, mappings) {
  return crypto.createHash('sha256').update(String(uid) + '\n' + stableStringify(mappings)).digest('hex');
}

// options.request: async function, returns true if the SYNC request succeeded
// options.uid: function returning the current uid
// options.stateFile: path of the state file (undefined: in memory only)
function createSync(options) {
  var mappings; // undefined until generateMappings succeeded
  var force = false;
  var state;

  function loadState() {
    if (state)
      return state;
    state = {};
    if (options.stateFile) {
      try {
        state = JSON.parse(fs.readFileSync(options.stateFile, 'utf8')) || {};
      } catch (err) {
        if (err.code !== 'ENOENT')
          log.error('Failed to read ' + options.stateFile + ': ' + err);
      }
    }
    return state;
  }

  function saveState(s) {
    state = s;
    if (!options.stateFile)
      return;
    try {
      fs.mkdirSync(path.dirname(options.stateFile), { recursive: true });
      fs.writeFileSync(options.stateFile, JSON.stringify(s));
    } catch (err) {
      // the state is kept in memory for this process
      log.error('Failed to write ' + options.stateFile + ': ' + err);
    }
  }

  return {
    // device mappings from generateMappings, undefined if it failed
    setMappings: function (m) {
      mappings = m;
    },

    // next requestSync sends a SYNC even if the devices didn't change (reload, server upgrade)
    forceNext: function () {
      force = true;
    },

    // returns true if a SYNC was requested
    requestSync: async function () {
      var uid = options.uid();
      if (!force && (!uid || mappings === undefined)) {
        log.info('SYNC skipped, no device mappings');
        return false;
      }
      var hash = mappings === undefined ? undefined : devicesHash(uid, mappings);
      var last = loadState();
      var now = Date.now();
      if (!force && hash === last.hash && now - (last.time || 0) < MAX_AGE) {
        log.info('SYNC skipped, devices unchanged');
        return false;
      }
      var forced = force;
      force = false;
      log.info('SYNC requested' + (forced ? ' (forced)' : ''));
      var ok = await options.request();
      if (ok && hash)
        saveState({ hash: hash, time: now });
      else if (!ok)
        // try again with the next requestSync
        saveState({});
      return true;
    }
  };
}

var instance;

// SYNC handling of the client
function get() {
  if (!instance) {
    var database = require('./database');
    var User = require('./user').User;
    instance = createSync({
      request: database.initiateSync,
      uid: database.getUid,
      stateFile: path.join(User.storagePath(), STATE_FILE)
    });
  }
  return instance;
}

module.exports = {
  get,
  createSync,
  devicesHash,
  stableStringify,
  MAX_AGE
};
