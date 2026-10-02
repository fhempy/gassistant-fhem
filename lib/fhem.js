'use strict';

const fetch = require('node-fetch');

var util = require('util');
var database = require('./database');
var version = require('./version');
const crypto = require('crypto');
const localQUERY = require('./localhandleQUERY');

var log;

var FHEM_longpoll = {};
var FHEM_devicesJSON = {};
var FHEM_csrfToken = {};
var FHEM_activeDevices = {};
var FHEM_connectionAuth = {};
var FHEM_deviceReadings = {};
var FHEM_devReadingVal = {};
var FHEM_reportStateStore = {};

var auth;
var use_ssl;

var initSync = 0;
var firstRun = 0;
var gassistant;
var connectioncounter = 0;
var longpollRequest = 0;

function getCurrentReadings() {
  return FHEM_devReadingVal;
}

FHEM.useSSL = function (s) {
  use_ssl = s;
}

FHEM.auth = function (a) {
  if (a === undefined) {
    auth = a;
    return;
  }

  var parts = a.split(':', 2);
  if (parts && parts.length == 2) {
    auth = {
      "user": parts[0],
      "pass": parts[1]
    };
    return;
  }

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
    log: log,
    fhem: this
  };
  if (config['auth']) {
    auth = config['auth'];
  }
  if (auth) {
    auth.sendImmediately = false;
  }
  FHEM_connectionAuth[base_url] = auth;

  FHEM_startLongpoll(this.connection);
}

//KEEP
//FIXME: add filter
function FHEM_startLongpoll(connection) {
  if (!FHEM_longpoll[connection.base_url]) {
    FHEM_longpoll[connection.base_url] = {};
    FHEM_longpoll[connection.base_url].connects = 0;
    FHEM_longpoll[connection.base_url].disconnects = 0;
    FHEM_longpoll[connection.base_url].received_total = 0;
  }

  if (FHEM_longpoll[connection.base_url].connected)
    return;
  FHEM_longpoll[connection.base_url].connects++;
  FHEM_longpoll[connection.base_url].received = 0;
  FHEM_longpoll[connection.base_url].connected = true;


  var filter = '.*';
  var since = 'null';
  if (FHEM_longpoll[connection.base_url].last_event_time)
    since = FHEM_longpoll[connection.base_url].last_event_time / 1000;
  var query = '?XHR=1' +
    '&inform=type=status;addglobal=1;filter=' + filter + ';since=' + since + ';fmt=JSON' +
    '&timestamp=' + Date.now();

  var url = encodeURI(connection.base_url + query);
  connection.log('starting longpoll: ' + url);

  var FHEM_longpollOffset = 0;
  var input = '';
  var request = require('request');
  connection.auth = FHEM_connectionAuth[connection.base_url];
  if (connection.auth)
    request = request.defaults({
      auth: connection.auth,
      rejectUnauthorized: false
    });
  longpollRequest = request.get({
    url: url
  }).on('data', async function (data) {
    //log.info( 'data: ' + data );
    if (!data)
      return;

    var length = data.length;
    FHEM_longpoll[connection.base_url].received += length;
    FHEM_longpoll[connection.base_url].received_total += length;

    input += data;

    try {
      var lastEventTime = Date.now();
      for (; ;) {
        var nOff = input.indexOf('\n', FHEM_longpollOffset);
        if (nOff < 0)
          break;
        var l = input.substr(FHEM_longpollOffset, nOff - FHEM_longpollOffset);
        FHEM_longpollOffset = nOff + 1;
        //log.info( 'Rcvd: ' + (l.length>132 ? l.substring(0,132)+'...('+l.length+')':l) );

        if (!l.length)
          continue;

        // log.info(d);
        var d;
        if (l.substr(0, 1) == '[') {
          try {
            d = JSON.parse(l);
          } catch (err) {
            connection.log('  longpoll JSON.parse: ' + err);
            continue;
          }
        } else
          d = l.split('<<', 3);

        if (d[0].match(/-ts$/))
          continue;
        if (d[0].match(/^#FHEMWEB:/))
          continue;

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
            var match2 = connection.fhem.filter.match(/room=(.*)/);
            if (match2) {
              if (rooms.indexOf(match2[1]) > -1) {
                //moved to Google room
                //send current devices to Firebase
                await connection.fhem.reload();
                //wait till syncfinished with await
                //initiate SYNC
                await database.initiateSync();
                log.info(d[0] + ' moved to room ' + match2[1]);
              } else {
                //check if device was in the room before
                if (FHEM_activeDevices[match[1]]) {
                  //removed from Google room
                  //send current devices to Firebase
                  await connection.fhem.reload();
                  //wait till syncfinished with await
                  //initiate SYNC
                  await database.initiateSync();
                  log.info(d[0] + ' removed from room ' + match2[1]);
                }
              }
            }
          }
          continue;
        }

        if (connection.fhem.gassistant && d[0] === connection.fhem.gassistant) {
          //log.info(d);
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
          }
          continue;
        }

        match = d[0].match(/([^-]*)-(.*)/);
        //TODO reload do here
        if (!match)
          continue;
        var device = match[1];
        var reading = match[2];

        //check gassistant device commands
        if (connection.fhem.gassistant && device === connection.fhem.gassistant) {
          //log.info(d);
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
          continue;
        }

        //log.info( 'device: ' + device );
        //log.info( 'reading: ' + reading );
        if (reading === undefined)
          continue;

        var value = d[1];
        //log.info( 'value: ' + value );
        if (value.match(/^set-/))
          continue;

        if (FHEM_deviceReadings.hasOwnProperty(device) && FHEM_deviceReadings[device].hasOwnProperty(reading)) {
          var readingSetting = FHEM_deviceReadings[device][reading].format;
          const REPORT_STATE = 1;
          await FHEM_update(device, reading, readingSetting, value, REPORT_STATE);
          FHEM_longpoll[connection.base_url].last_event_time = lastEventTime;
        }
      }

    } catch (err) {
      connection.log.error('  error in longpoll connection: ' + err);

    }

    input = input.substr(FHEM_longpollOffset);
    FHEM_longpollOffset = 0;

    FHEM_longpoll[connection.base_url].disconnects = 0;

  }).on('response', function (response) {
    if (response.headers && response.headers['x-fhem-csrftoken'])
      FHEM_csrfToken[connection.base_url] = response.headers['x-fhem-csrftoken'];
    else
      FHEM_csrfToken[connection.base_url] = '';

    if (!gassistant)
      connection.fhem.getFhemGassistantDevice();

  }).on('end', function () {
    FHEM_longpoll[connection.base_url].connected = false;

    FHEM_longpoll[connection.base_url].disconnects++;
    var timeout = 5000 * FHEM_longpoll[connection.base_url].disconnects - 300;
    if (timeout > 30000) timeout = 30000;

    connection.log('longpoll ended, reconnect in: ' + timeout + 'msec');
    setTimeout(function () {
      FHEM_startLongpoll(connection)
    }, timeout);

  }).on('error', function (err) {
    FHEM_longpoll[connection.base_url].connected = false;

    FHEM_longpoll[connection.base_url].disconnects++;
    var timeout = 5000 * FHEM_longpoll[connection.base_url].disconnects;
    if (timeout > 30000) timeout = 30000;

    connection.log('longpoll error: ' + err + ', retry in: ' + timeout + 'msec');
    setTimeout(function () {
      FHEM_startLongpoll(connection)
    }, timeout);

  });
}

async function updateDeviceReading(device, reading, val) {
  FHEM_devReadingVal[device][reading] = val;
  await database.getRealDB().ref('users/' + database.getUid() + '/readings/' + device.replace(/\.|\#|\[|\]|\$/g, '_') + '/' + reading.replace(/\.|\#|\[|\]|\$/g, '_')).set({
    value: val,
    devname: device
  });
}

async function updateSelectReading(device, reading, val) {
  var allDevices = database.getMappings();
  if (allDevices[device.replace(/\.|\#|\[|\]|\$/g, '_')]) {
    var d = allDevices[device.replace(/\.|\#|\[|\]|\$/g, '_')]['XXXDEVICEDEFXXX'];
    if (d.mappings) {
      Object.keys(d.mappings).forEach(async function (mapping) {
        if (!Array.isArray(d.mappings[mapping])) {
          if (d.mappings[mapping].selectReading) {
            if (d.mappings[mapping].reading.includes(reading)) {
              FHEM_devReadingVal[device][mapping + '-' + d.mappings[mapping].selectReading] = reading.replace(/\.|\#|\[|\]|\$/g, '_');
              await database.getRealDB().ref('users/' + database.getUid() + '/readings/' + device.replace(/\.|\#|\[|\]|\$/g, '_') +
                '/' + mapping + '-' + d.mappings[mapping].selectReading).set({
                  'value': reading.replace(/\.|\#|\[|\]|\$/g, '_'),
                  devname: device
                });
            }
          }
        }
      });
    }
  }
}

async function
  FHEM_update(device, reading, readingSetting, orig, reportState) {
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
    if (FHEM_deviceReadings[device][reading].compareFunction) {
      eval('FHEM_deviceReadings[device][reading].compareFunction = ' + FHEM_deviceReadings[device][reading].compareFunction);
      if (!FHEM_reportStateStore[device][reading].oldValue) {
        //first call for this reading
        FHEM_reportStateStore[device][reading].cancelOldTimeout = FHEM_deviceReadings[device][reading].compareFunction('', 0, orig, undefined, 0, undefined, database.reportStateWithData, dev);
      } else {
        var store = FHEM_reportStateStore[device][reading];
        FHEM_reportStateStore[device][reading].cancelOldTimeout = FHEM_deviceReadings[device][reading].compareFunction(store.oldValue, store.oldTimestamp, orig, store.cancelOldTimeout, oldDevStore.oldTimestamp, oldDevStore.cancelOldTimeout, database.reportStateWithData, dev);
      }

      if (FHEM_reportStateStore[device][reading].cancelOldTimeout) {
        FHEM_reportStateStore[device].cancelOldTimeout = FHEM_reportStateStore[device][reading].cancelOldTimeout;
        FHEM_reportStateStore[device].oldTimestamp = Date.now();
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
  longpollRequest.abort();
  await this.clearDatabase();
  await this.connection.fhem.serverprocess.connectAll();
}

function setLoginFailed(fhem, err) {
  fhem.execute('setreading ' + fhem.gassistant + ' gassistant-fhem-connection login failed, please retry');
  fhem.execute('setreading ' + fhem.gassistant + ' gassistant-fhem-lasterror ' + err);
  //fhem.execute('set ' + fhem.gassistant + ' loginURL ' + database.getUrl());
}

FHEM.prototype.getFhemGassistantDevice = function () {
  FHEM_execute(this.connection, "jsonlist2 TYPE=gassistant",
    function (res) {
      try {
        res = JSON.parse(res);
        this.log.info('FHEM Google Assistant device detected: ' + res.Results[0].Name);
        this.gassistant = res.Results[0].Name;
        gassistant = this.gassistant;
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
                this.checkAndSetGenericDeviceType();
                this.log.info('Connection: OK');
              } catch (err) {
                console.error(err);
                setLoginFailed(this, err);
              }
            } else
              this.setLoginRequired();
          }.bind(this));
      } catch (err) {
        connectioncounter = connectioncounter - 1;
        if (connectioncounter == 0) {
          this.log.error('Please define Google Assistant device in FHEM: define gassistant gassistant');
          process.exit(1);
        }
      }
    }.bind(this));
}

FHEM.prototype.clearDatabase = async function () {
  try {
    var currReadings = await database.getRealDB().ref('users/' + database.getUid() + '/readings').once('value');
    if (Object.keys(currReadings.val()).length === 0) {
      firstRun = 1;
    }
  } catch (err) {
    firstRun = 1;
  }

  try {
    await database.getRealDB().ref('users/' + database.getUid() + '/devices').remove();
    await database.getRealDB().ref('users/' + database.getUid() + '/readings').remove();
  } catch (err) {
    this.log.error('Realtime Database deletion failed: ' + err);
  }

  var batch = database.getDB().batch();
  //DELETE current data in firestore database
  try {
    var ref = await database.getDB().collection(database.getUid()).doc('devices').collection('devices').get();
    for (var r of ref.docs) {
      batch.delete(r.ref);
    }
  } catch (err) {
    this.log.error('Device deletion failed: ' + err);
  }

  try {
    var ref = await database.getDB().collection(database.getUid()).doc('devices').collection('attributes').get();
    for (var r of ref.docs) {
      batch.delete(r.ref);
    }
  } catch (err) {
    this.log.error('Attribute deletion failed: ' + err);
  }
  await batch.commit();
}

//KEEP
FHEM.prototype.connect = async function (callback, filter) {
  //this.checkAndSetGenericDeviceType();

  if (!filter) filter = this.filter;

  this.devices = [];

  if (FHEM_csrfToken[this.connection.base_url] === undefined) {
    setTimeout(function () {
      this.connection.fhem.connect(callback, filter);
    }.bind(this), 500);
    return;
  }

  this.log.info('Fetching FHEM devices...');

  let cmd = 'jsonlist2';
  if (filter)
    cmd += ' ' + filter;
  if (FHEM_csrfToken[this.connection.base_url])
    cmd += '&fwcsrf=' + FHEM_csrfToken[this.connection.base_url];
  const url = encodeURI(this.connection.base_url + '?cmd=' + cmd + '&XHR=1');
  this.log.info('fetching: ' + url);

  var request = require('request-promise');
  this.connection.auth = FHEM_connectionAuth[this.connection.base_url];
  if (this.connection.auth)
    request = request.defaults({
      auth: this.connection.auth,
      rejectUnauthorized: false
    });

  var response = await request({
    url: url,
    json: true,
    gzip: true,
    resolveWithFullResponse: true
  });
  if (response.statusCode === 200) {
    var json = response.body;
    // log.info("got json: " + util.inspect(json));
    this.log.info('got: ' + json['totalResultsReturned'] + ' results');
    //TODO check results if they are different from previous ones (do not compare times!!)
    if (json['totalResultsReturned']) {
      var con = {
        base_url: this.connection.base_url
      };
      this.connection.auth = FHEM_connectionAuth[this.connection.base_url];
      if (this.connection.auth) {
        con.auth = this.connection.auth;
      }

      var dObj = {};
      json['Results'].map(function (s) {
        FHEM_activeDevices[s.Internals.NAME] = 1;
        dObj[s.Internals.NAME] = {
          'json': s,
          'connection': con.base_url
        }, {
          merge: true
        };
      }.bind(this));
      FHEM_devicesJSON = Object.assign(FHEM_devicesJSON, dObj);

      initSync = 1;

      //send current readings database.updateDeviceReading
      var genMapRes = await database.generateMappings(FHEM_devicesJSON);
      FHEM_deviceReadings = Object.assign(FHEM_deviceReadings, genMapRes.readings);
      database.setMappings(genMapRes.mappings);

      json['Results'].map(function (s) {
        for (var reading in s.Readings) {
          if (FHEM_deviceReadings.hasOwnProperty(s.Internals.NAME) && FHEM_deviceReadings[s.Internals.NAME].hasOwnProperty(reading)) {
            const REPORT_STATE = 0;
            FHEM_update(s.Internals.NAME, reading, FHEM_deviceReadings[s.Internals.NAME][reading].format, s.Readings[reading].Value, REPORT_STATE);
          }
        }
      }.bind(this));

      //if (firstRun): removed to init sync on every start
      await database.initiateSync();
    }
    this.execute('setreading ' + this.gassistant + ' gassistant-fhem-connection connected');

    if (callback)
      callback(this.devices);

  } else {
    this.log.error('There was a problem connecting to FHEM');
    if (response)
      this.log.error('  ' + response.statusCode + ': ' + response.statusMessage);
  }
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
FHEM.prototype.checkAndSetGenericDeviceType = function () {
  this.log('Checking devices and attributes...');

  var cmd = '{AttrVal("global","userattr","")}';
  this.execute(cmd,
    async function (result) {
      //if( result === undefined )
      //result = '';

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

      let m;
      m = result.match(/(^| )genericDeviceType:(\S*)/);
      var gdtList = [];
      if (m)
        gdtList = m[2].split(',');
      var dt = await database.getConfiguration();
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
        var cmd = '{addToAttrList( "genericDeviceType:' + newGdtList.join() + '") }';
        this.execute(cmd);
      }
    }.bind(this));
};

//KEEP
function
  FHEM_execute(connection, cmd, callback) {
  //log.info('starting FHEM_execute');
  let url = connection.base_url + '?cmd=' + encodeURIComponent(cmd);
  if (FHEM_csrfToken[connection.base_url])
    url += '&fwcsrf=' + encodeURIComponent(FHEM_csrfToken[connection.base_url]);
  url += '&XHR=1';
  log.info('  executing: ' + url);

  connection.auth = FHEM_connectionAuth[connection.base_url];
  var request = require('request');
  request = request.defaults({
    auth: connection.auth,
    rejectUnauthorized: false
  });

  request
    .get({
      url: url,
      gzip: true
    },
      function (err, response, result) {
        if (!err && response.statusCode == 200) {
          result = result.replace(/[\r\n]/g, '');
          if (callback)
            callback(result);

        } else {
          log.info('There was a problem connecting to FHEM (' + url + ').');
          if (response)
            log.info('  ' + response.statusCode + ': ' + response.statusMessage);

        }

      })
    .on('error', function (err) {
      console.error('There was a problem connecting to FHEM (' + url + '):' + err);
    });
};

async function FHEM_execute_await(connection, cmd) {
  //log.info('starting FHEM_execute_await');
  let url = connection.base_url + '?cmd=' + encodeURIComponent(cmd);
  if (FHEM_csrfToken[connection.base_url])
    url += '&fwcsrf=' + encodeURIComponent(FHEM_csrfToken[connection.base_url]);
  url += '&XHR=1';
  log.info('  executing: ' + url);

  connection.auth = FHEM_connectionAuth[connection.base_url];
  var headers = {
    'content-type': 'application/json'
  };
  if (connection.auth) {
    headers['Authorization'] = 'Basic ' + base64.encode(connection.auth.user + ':' + connection.auth.pass);
  }
  var res = await fetch(url, {
    headers: headers
  });
  return await res.json();
}

module.exports = {
  FHEM,
  FHEM_execute,
  getCurrentReadings
};