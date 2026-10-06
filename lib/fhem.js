'use strict';

var database = require('./database');
const fhemhttp = require('./fhemhttp');
const localQUERY = require('./localhandleQUERY');

var log = require('./logger')._system;

var FHEM_longpoll = {};
var FHEM_devicesJSON = {};
var FHEM_csrfToken = {};
var FHEM_activeDevices = {};
var FHEM_connectionAuth = {};
var FHEM_deviceReadings = {};
var FHEM_devReadingVal = {};
var FHEM_reportStateStore = {};

var cliAuth;
var use_ssl;

var initSync = 0;
var gassistant;
var connectioncounter = 0;

function getCurrentReadings() {
  return FHEM_devReadingVal;
}

// do not write secrets to the log
function redact(str) {
  return str.replace(/(refreshToken(%20|\+|\s)+)[^&\s]+/g, '$1***');
}

// parse user:password, password may contain ':'
function parseAuth(a) {
  if (typeof a !== 'string')
    return undefined;
  var idx = a.indexOf(':');
  if (idx < 1)
    return undefined;
  return {
    user: a.substring(0, idx),
    pass: a.substring(idx + 1)
  };
}

FHEM.useSSL = function (s) {
  use_ssl = s;
}

FHEM.auth = function (a) {
  if (a === undefined) {
    cliAuth = undefined;
    return;
  }

  cliAuth = parseAuth(a);
  if (cliAuth)
    return;

  console.log('error: auth format wrong. must be user:password');
  process.exit(0);
}

//KEEP
function FHEM(logInstance, config, server) {
  connectioncounter = connectioncounter + 1;
  this.log = logInstance;
  log = logInstance;
  this.config = config;
  this.server = config['server'];
  this.port = config['port'];
  this.filter = config['filter'];
  this.gassistant = undefined;
  this.serverprocess = server;

  var base_url = 'http://';
  if ('ssl' in config) {
    if (typeof config.ssl !== 'boolean') {
      this.log.error('config: value for ssl has to be boolean.');
      process.exit(0);
    }
    if (config.ssl) {
      base_url = 'https://';
    }
  } else if (use_ssl) {
    base_url = 'https://';
  }
  base_url += this.server + ':' + this.port;

  if (config.webname) {
    base_url += '/' + config.webname;
  } else {
    base_url += '/fhem';
  }

  this.connection = {
    base_url: base_url,
    log: logInstance,
    fhem: this
  };
  // connection specific auth from config, otherwise auth from command line
  FHEM_connectionAuth[base_url] = config['auth'] || cliAuth;

  FHEM_startLongpoll(this.connection);
}

//KEEP
//FIXME: add filter
function FHEM_startLongpoll(connection) {
  var lp = FHEM_longpoll[connection.base_url];
  if (!lp) {
    lp = FHEM_longpoll[connection.base_url] = {};
    lp.connects = 0;
    lp.disconnects = 0;
    lp.received_total = 0;
  }

  if (lp.connected)
    return;
  lp.connects++;
  lp.received = 0;
  lp.connected = true;

  var filter = '.*';
  var since = 'null';
  if (lp.last_event_time)
    since = lp.last_event_time / 1000;
  var query = '?XHR=1' +
    '&inform=type=status;addglobal=1;filter=' + filter + ';since=' + since + ';fmt=JSON' +
    '&timestamp=' + Date.now();

  var url = encodeURI(connection.base_url + query);
  connection.log('starting longpoll: ' + url);

  var input = '';
  // lines are processed strictly one after another, also if they arrive in different chunks
  var processing = Promise.resolve();

  lp.request = fhemhttp.stream(url, FHEM_connectionAuth[connection.base_url], {
    response: function (response) {
      if (response.headers && response.headers['x-fhem-csrftoken'])
        FHEM_csrfToken[connection.base_url] = response.headers['x-fhem-csrftoken'];
      else
        FHEM_csrfToken[connection.base_url] = '';

      if (response.statusCode === 200 && !gassistant)
        connection.fhem.getFhemGassistantDevice();
    },

    data: function (data) {
      if (!data)
        return;

      lp.received += data.length;
      lp.received_total += data.length;
      lp.disconnects = 0;

      input += data;
      var lines = input.split('\n');
      input = lines.pop();
      var lastEventTime = Date.now();

      for (var l of lines) {
        if (!l.length)
          continue;
        processing = processing.then(handleLongpollLine.bind(null, connection, l, lastEventTime)).catch(function (err) {
          connection.log.error('  error in longpoll connection: ' + err);
        });
      }
    },

    close: function (err) {
      lp.connected = false;
      lp.request = undefined;
      lp.disconnects++;
      var timeout = 5000 * lp.disconnects - (err ? 0 : 300);
      if (timeout > 30000) timeout = 30000;

      if (err)
        connection.log('longpoll error: ' + err + ', retry in: ' + timeout + 'msec');
      else
        connection.log('longpoll ended, reconnect in: ' + timeout + 'msec');
      setTimeout(function () {
        FHEM_startLongpoll(connection)
      }, timeout);
    }
  });
}

async function handleLongpollLine(connection, l, lastEventTime) {
  var d;
  if (l.substr(0, 1) == '[') {
    try {
      d = JSON.parse(l);
    } catch (err) {
      connection.log('  longpoll JSON.parse: ' + err);
      return;
    }
  } else
    d = l.split('<<', 3);

  if (typeof d[0] !== 'string')
    return;
  if (d[0].match(/-ts$/))
    return;
  if (d[0].match(/^#FHEMWEB:/))
    return;

  //TODO check for assistantName, gassistantName attribute changes
  var match = d[0].match(/([^-]*)-a-room/);
  if (match) {
    //room update
    // [ 'XMI_158d0002531704-a-room',
    //   'Alexa,MiSmartHome',
    //   'Alexa,MiSmartHome' ]
    //rooms => d[1];
    if (d[1]) {
      var rooms = d[1].split(',');
      var match2 = (connection.fhem.filter || '').match(/room=(.*)/);
      if (match2) {
        if (rooms.indexOf(match2[1]) > -1) {
          //moved to Google room
          //send current devices to Firebase
          await connection.fhem.reload();
          //initiate SYNC
          await database.initiateSync();
          log.info(d[0] + ' moved to room ' + match2[1]);
        } else if (FHEM_activeDevices[match[1]]) {
          //removed from Google room
          //send current devices to Firebase
          await connection.fhem.reload();
          //initiate SYNC
          await database.initiateSync();
          log.info(d[0] + ' removed from room ' + match2[1]);
        }
      }
    }
    return;
  }

  if (connection.fhem.gassistant && d[0] === connection.fhem.gassistant) {
    if (d[1] === 'unregister') {
      connection.log("User account and user data deletion initiated...");
      await database.deleteUserAccount();
      connection.log("User account and user data deleted.");
    } else if (d[1] === 'reload') {
      connection.fhem.execute('setreading ' + connection.fhem.gassistant + ' gassistant-fhem-connection reloading...');
      connection.log("Reload and SYNC to Google");
      //reload all devices
      initSync = 0;
      await connection.fhem.reload();
      //initiate sync
      if (initSync) {
        await database.initiateSync();
      }
    } else if (/^update(\s|$)/.test(d[1] || '')) {
      // FW_directNotify(<gassistant>, "update [version]"): install with npm and restart via FHEM
      await require('./update').update(connection.fhem, d[1].replace(/^update\s*/, ''));
    }
    return;
  }

  match = d[0].match(/([^-]*)-(.*)/);
  if (!match)
    return;
  var device = match[1];
  var reading = match[2];

  //check gassistant device commands
  if (connection.fhem.gassistant && device === connection.fhem.gassistant) {
    if (d.length == 3) {
      if (reading === 'unregister') {
        log.info("User account and user data deletion initiated...");
        await database.deleteUserAccount();
        log.info("User account and user data deleted.");
      } else if (reading === 'authcode') {
        try {
          connection.fhem.execute('setreading ' + connection.fhem.gassistant + ' gassistant-fhem-connection connecting...');
          await database.handleAuthCode(d[1]);
          await connection.fhem.serverprocess.startConnection();
        } catch (err) {
          setLoginFailed(connection.fhem, err);
        }
      } else if (reading === 'update') {
        // "trigger <gassistant> update: [version]" or "set <gassistant> update [version]"
        await require('./update').update(connection.fhem, d[1]);
      } else if (reading === 'clearCredentials') {
        //delete refresh token is done by 39_gassistant.pm
      } else if (reading === 'reload') {
        //reload all devices
        initSync = 0;
        await connection.fhem.reload();
        //initiate sync
        if (initSync) {
          await database.initiateSync();
        }
      }
    }
    return;
  }

  if (reading === undefined)
    return;

  var value = d[1];
  if (typeof value !== 'string')
    return;
  if (value.match(/^set-/))
    return;

  if (FHEM_deviceReadings.hasOwnProperty(device) && FHEM_deviceReadings[device].hasOwnProperty(reading)) {
    var readingSetting = FHEM_deviceReadings[device][reading].format;
    const REPORT_STATE = 1;
    await FHEM_update(device, reading, readingSetting, value, REPORT_STATE);
    FHEM_longpoll[connection.base_url].last_event_time = lastEventTime;
  }
}

async function updateDeviceReading(device, reading, val) {
  FHEM_devReadingVal[device][reading] = val;
  await database.setReading(device, reading, val);
}

async function updateSelectReading(device, reading, val) {
  var allDevices = database.getMappings();
  var devKey = database.escapeKey(device);
  if (!allDevices[devKey])
    return;

  var d = allDevices[devKey]['XXXDEVICEDEFXXX'];
  if (!d || !d.mappings)
    return;

  for (var mapping of Object.keys(d.mappings)) {
    var m = d.mappings[mapping];
    if (Array.isArray(m) || !m.selectReading || !m.reading || !m.reading.includes(reading))
      continue;
    FHEM_devReadingVal[device][mapping + '-' + m.selectReading] = database.escapeKey(reading);
    await database.setReading(device, mapping + '-' + m.selectReading, database.escapeKey(reading));
  }
}

// Report State: every request is a Cloud Function call, so
//  - unchanged states are not reported again
//  - changes within REPORT_STATE_DELAY are sent together in one request
const REPORT_STATE_DELAY = 1000;
var reportStateLast = {};    // device id -> last reported state (JSON)
var reportStatePending = {}; // device id -> state to report
var reportStateTimer;

function reportStateWithData(data) {
  var states = data && data.payload && data.payload.devices && data.payload.devices.states;
  if (!states || typeof states !== 'object')
    return;
  for (var id of Object.keys(states)) {
    if (reportStateLast[id] === JSON.stringify(states[id])) {
      // back to the reported state, a pending change is obsolete
      delete reportStatePending[id];
      continue;
    }
    reportStatePending[id] = states[id];
  }
  if (!reportStateTimer && Object.keys(reportStatePending).length > 0)
    reportStateTimer = setTimeout(flushReportState, REPORT_STATE_DELAY);
}

function flushReportState() {
  clearTimeout(reportStateTimer);
  reportStateTimer = undefined;
  var states = reportStatePending;
  reportStatePending = {};
  var ids = Object.keys(states);
  if (ids.length === 0)
    return Promise.resolve();
  for (var id of ids)
    reportStateLast[id] = JSON.stringify(states[id]);
  return database.reportStateWithData({
    requestId: (Math.floor(Math.random() * Math.floor(1000000000000))).toString(),
    agentUserId: database.getUid(),
    payload: {
      devices: {
        states: states
      }
    }
  }).catch(function (err) {
    // report state errors must not crash the process, report again on the next change
    log.error('reportstate failed: ' + err);
    for (var id of ids) {
      if (reportStateLast[id] === JSON.stringify(states[id]))
        delete reportStateLast[id];
    }
  });
}

async function FHEM_update(device, reading, readingSetting, orig, reportState) {
  if (orig === undefined)
    return;

  if (!FHEM_devReadingVal[device])
    FHEM_devReadingVal[device] = {};
  if (!FHEM_devReadingVal[device][reading])
    FHEM_devReadingVal[device][reading] = '';

  if (orig !== FHEM_devReadingVal[device][reading] || reportState === 0) {
    await updateDeviceReading(device, reading, orig);
    await updateSelectReading(device, reading, orig);
    log.info('update reading: ' + device + ':' + reading + ' = ' + orig);
  }

  if (!FHEM_reportStateStore[device])
    FHEM_reportStateStore[device] = {};

  if (!FHEM_reportStateStore[device][reading])
    FHEM_reportStateStore[device][reading] = {};

  if (reportState) {
    var query = {
      intent: 'action.devices.QUERY',
      payload: {
        devices: []
      }
    };

    query.payload.devices.push({
      id: device,
      customData: {
        device: device
      }
    });

    const reportstate = 1;
    var deviceQueryRes = await localQUERY.processQUERY(database.getUid(), query, reportstate);

    //prepare response
    var dev = {
      requestId: (Math.floor(Math.random() * Math.floor(1000000000000))).toString(),
      agentUserId: database.getUid(),
      payload: {
        devices: {
          states: {}
        }
      }
    };
    dev.payload.devices.states = deviceQueryRes.devices;

    const oldDevStore = FHEM_reportStateStore[device];
    var readingDef = FHEM_deviceReadings[device] && FHEM_deviceReadings[device][reading];
    if (readingDef && readingDef.compareFunction) {
      // compareFunction is delivered as source code by the server
      if (typeof readingDef.compareFunction === 'string')
        readingDef.compareFunction = eval('(' + readingDef.compareFunction + ')');
      var store = FHEM_reportStateStore[device][reading];
      if (!store.oldValue) {
        //first call for this reading
        store.cancelOldTimeout = readingDef.compareFunction('', 0, orig, undefined, 0, undefined, reportStateWithData, dev);
      } else {
        store.cancelOldTimeout = readingDef.compareFunction(store.oldValue, store.oldTimestamp, orig, store.cancelOldTimeout, oldDevStore.oldTimestamp, oldDevStore.cancelOldTimeout, reportStateWithData, dev);
      }

      if (store.cancelOldTimeout) {
        oldDevStore.cancelOldTimeout = store.cancelOldTimeout;
        oldDevStore.oldTimestamp = Date.now();
      }
    }
  }

  FHEM_reportStateStore[device][reading].oldValue = orig;
  FHEM_reportStateStore[device][reading].oldTimestamp = Date.now();

  //FIXME ReportState only when connected
}

FHEM.prototype.setLocalHomeState = async function (state) {
  this.execute('setreading ' + this.gassistant + ' gassistant-fhem-localHome ' + state);
}

FHEM.prototype.setLocalHomeDevices = async function (count) {
  this.execute('setreading ' + this.gassistant + ' gassistant-fhem-localHomeDevices ' + count);
}

//KEEP
FHEM.prototype.execute = function (cmd, callback) {
  FHEM_execute(this.connection, cmd, callback);
};

FHEM.prototype.execute_await = async function (cmd) {
  return await FHEM_execute_await(this.connection, cmd);
}

FHEM.prototype.reload = async function () {
  FHEM_activeDevices = {};
  FHEM_devicesJSON = {};
  FHEM_deviceReadings = {};
  this.execute('setreading ' + this.gassistant + ' gassistant-fhem-lastServerError none');
  // restart longpoll, it reconnects automatically
  var lp = FHEM_longpoll[this.connection.base_url];
  if (lp && lp.request)
    lp.request.destroy();
  await this.clearDatabase();
  await this.connection.fhem.serverprocess.connectAll();
}

function setLoginFailed(fhem, err) {
  fhem.execute('setreading ' + fhem.gassistant + ' gassistant-fhem-connection login failed, please retry');
  fhem.execute('setreading ' + fhem.gassistant + ' gassistant-fhem-lasterror ' + err);
}

FHEM.prototype.getFhemGassistantDevice = function () {
  FHEM_execute(this.connection, "jsonlist2 TYPE=gassistant",
    function (res) {
      try {
        res = JSON.parse(res);
        this.log.info('FHEM Google Assistant device detected: ' + res.Results[0].Name);
        this.gassistant = res.Results[0].Name;
        gassistant = this.gassistant;
      } catch (err) {
        connectioncounter = connectioncounter - 1;
        if (connectioncounter == 0) {
          this.log.error('Please define Google Assistant device in FHEM: define gassistant gassistant');
          process.exit(1);
        }
        return;
      }

      database.setFhemDeviceInstance(this);
      this.execute('setreading ' + this.gassistant + ' gassistant-fhem-lastServerError none');
      var cmd = 'set ' + this.gassistant + ' loginURL ' + database.getUrl();
      this.execute(cmd);
      this.getRefreshToken(
        async function (refreshToken) {
          if (refreshToken) {
            this.execute('setreading ' + this.gassistant + ' gassistant-fhem-connection connecting...');
            database.setRefreshToken(refreshToken);
            this.log.info('Found refresh token in reading');
            try {
              await database.refreshAllTokens();
              this.log.info('refreshAllTokens executed');
              await this.clearDatabase();
              await this.connection.fhem.serverprocess.startConnection();
              this.execute('setreading ' + this.gassistant + ' gassistant-fhem-lasterror none');
              await this.checkAndSetGenericDeviceType();
              this.log.info('Connection: OK');
            } catch (err) {
              console.error(err);
              setLoginFailed(this, err);
            }
          } else
            this.setLoginRequired();
        }.bind(this));
    }.bind(this));
}

FHEM.prototype.clearDatabase = async function () {
  await database.clearUserData();
}

//KEEP
FHEM.prototype.connect = async function (callback, filter) {
  if (!filter) filter = this.filter;

  this.devices = [];

  // wait for the csrf token from longpoll
  while (FHEM_csrfToken[this.connection.base_url] === undefined) {
    await new Promise(function (resolve) {
      setTimeout(resolve, 500);
    });
  }

  this.log.info('Fetching FHEM devices...');

  let cmd = 'jsonlist2';
  if (filter)
    cmd += ' ' + filter;
  let url = this.connection.base_url + '?cmd=' + encodeURIComponent(cmd) + '&XHR=1';
  if (FHEM_csrfToken[this.connection.base_url])
    url += '&fwcsrf=' + encodeURIComponent(FHEM_csrfToken[this.connection.base_url]);
  this.log.info('fetching: ' + url);

  var response;
  try {
    response = await fhemhttp.get(url, FHEM_connectionAuth[this.connection.base_url]);
  } catch (err) {
    this.log.error('There was a problem connecting to FHEM: ' + err);
    return;
  }

  if (response.statusCode !== 200) {
    this.log.error('There was a problem connecting to FHEM');
    this.log.error('  ' + response.statusCode + ': ' + response.statusMessage);
    return;
  }

  var json;
  try {
    json = JSON.parse(response.body);
  } catch (err) {
    this.log.error('Invalid response from FHEM: ' + err);
    return;
  }

  this.log.info('got: ' + json['totalResultsReturned'] + ' results');
  //TODO check results if they are different from previous ones (do not compare times!!)
  if (json['totalResultsReturned']) {
    var dObj = {};
    for (var s of json['Results']) {
      FHEM_activeDevices[s.Internals.NAME] = 1;
      dObj[s.Internals.NAME] = {
        'json': s,
        'connection': this.connection.base_url
      };
    }
    FHEM_devicesJSON = Object.assign(FHEM_devicesJSON, dObj);

    initSync = 1;

    //send current readings database.updateDeviceReading
    var genMapRes = await database.generateMappings(FHEM_devicesJSON);
    if (!genMapRes.mappings)
      this.log.error('Failed to generate device mappings');
    FHEM_deviceReadings = Object.assign(FHEM_deviceReadings, genMapRes.readings);
    database.setMappings(genMapRes.mappings);

    var updates = [];
    for (var s of json['Results']) {
      for (var reading in s.Readings) {
        if (FHEM_deviceReadings.hasOwnProperty(s.Internals.NAME) && FHEM_deviceReadings[s.Internals.NAME].hasOwnProperty(reading)) {
          const REPORT_STATE = 0;
          updates.push(FHEM_update(s.Internals.NAME, reading, FHEM_deviceReadings[s.Internals.NAME][reading].format, s.Readings[reading].Value, REPORT_STATE));
        }
      }
    }
    var results = await Promise.allSettled(updates);
    for (var r of results) {
      if (r.status === 'rejected')
        this.log.error('Failed to update reading: ' + r.reason);
    }

    //initiate sync on every start
    await database.initiateSync();
  }
  this.execute('setreading ' + this.gassistant + ' gassistant-fhem-connection connected');

  if (callback)
    callback(this.devices);
}

FHEM.prototype.getRefreshToken = function (callback) {
  this.log('Get refresh token...');
  var cmd = 'get ' + this.gassistant + ' refreshToken';
  this.execute(cmd,
    async function (result) {
      if (result === '') {
        await callback(undefined);
      } else {
        await callback(result);
      }
    });
}

FHEM.prototype.setLoginRequired = function () {
  var cmd = 'setreading ' + this.gassistant + ' gassistant-fhem-connection login required; set ' + this.gassistant + ' loginURL ' + database.getUrl();
  this.execute(cmd);
  this.execute('setreading ' + this.gassistant + ' gassistant-fhem-lasterror none');
}

//KEEP
FHEM.prototype.checkAndSetGenericDeviceType = async function () {
  this.log('Checking devices and attributes...');

  var result = await this.execute_await('{AttrVal("global","userattr","")}');
  if (result === undefined) {
    this.log.error('Failed to read global userattr');
    return;
  }
  result = result.replace(/[\r\n]/g, '');

  if (!result.match(/(^| )homebridgeMapping\b/)) {
    this.execute('{ addToAttrList( "homebridgeMapping:textField-long" ) }');
    this.log.info('homebridgeMapping attribute created.');
  }

  if (!result.match(/(^| )realRoom\b/)) {
    this.execute('{ addToAttrList( "realRoom:textField" ) }');
    this.log.info('realRoom attribute created.');
  }

  if (!result.match(/(^| )gassistantName\b/)) {
    this.execute('{ addToAttrList( "gassistantName:textField" ) }');
    this.log.info('gassistantName attribute created.');
  }

  if (!result.match(/(^| )assistantName\b/)) {
    this.execute('{ addToAttrList( "assistantName:textField" ) }');
    this.log.info('assistantName attribute created.');
  }

  let m = result.match(/(^| )genericDeviceType:(\S*)/);
  var gdtList = [];
  if (m)
    gdtList = m[2].split(',');
  var dt = await database.getConfiguration();
  if (!Array.isArray(dt.devicetypes)) {
    this.log.error('Failed to get supported Google Device Types from server');
    return;
  }
  this.log.info("Supported Google Device Types: " + dt.devicetypes.toString());
  var l1 = gdtList.length;
  gdtList = gdtList.concat(dt.devicetypes);
  var newGdtList = gdtList.filter(function (elem, pos) {
    return gdtList.indexOf(elem) == pos;
  });
  var l2 = newGdtList.length;
  if (l2 > l1) {
    if (l1 > 0)
      this.execute('{ delFromAttrList( "genericDeviceType:' + m[2] + '") }');
    this.execute('{addToAttrList( "genericDeviceType:' + newGdtList.join() + '") }');
  }
};

function buildExecuteUrl(connection, cmd) {
  let url = connection.base_url + '?cmd=' + encodeURIComponent(cmd);
  if (FHEM_csrfToken[connection.base_url])
    url += '&fwcsrf=' + encodeURIComponent(FHEM_csrfToken[connection.base_url]);
  url += '&XHR=1';
  return url;
}

// resolves with the response text or undefined on error
async function FHEM_execute_await(connection, cmd) {
  const url = buildExecuteUrl(connection, cmd);
  log.info('  executing: ' + redact(url));

  try {
    var response = await fhemhttp.get(url, FHEM_connectionAuth[connection.base_url]);
    if (response.statusCode == 200)
      return response.body;
    log.info('There was a problem connecting to FHEM (' + redact(url) + ').');
    log.info('  ' + response.statusCode + ': ' + response.statusMessage);
  } catch (err) {
    console.error('There was a problem connecting to FHEM (' + redact(url) + '):' + err);
  }
  return undefined;
}

//KEEP
function FHEM_execute(connection, cmd, callback) {
  FHEM_execute_await(connection, cmd).then(function (result) {
    if (result !== undefined && callback)
      return callback(result.replace(/[\r\n]/g, ''));
  }).catch(function (err) {
    log.error('FHEM_execute callback failed: ' + err);
  });
};

module.exports = {
  FHEM,
  FHEM_execute,
  getCurrentReadings,
  parseAuth,
  redact,
  reportStateWithData,
  flushReportState
};
