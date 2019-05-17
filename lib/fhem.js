'use strict';


const fetch = require('node-fetch');

var util = require('util');
var database = require('./database');
var version = require('./version');
var dynfcts = require('./dynamicfunctions');
const crypto = require('crypto');

module.exports = {
    FHEM: FHEM,
    FHEM_execute: FHEM_execute
};

var log;

var FHEM_longpoll = {};
var FHEM_csrfToken = {};
var FHEM_activeDevices = {};
var FHEM_connectionAuth = {};
var FHEM_deviceReadings = {};

var auth;
var use_ssl;

var md5;
var initSync = 0;
var gassistant;

FHEM.useSSL = function(s) {
   use_ssl = s;
}

FHEM.auth = function(a) {
  if( a === undefined ) {
    auth = a;
    return;
  }

  var parts = a.split( ':', 2 );
  if( parts && parts.length == 2 ) {
    auth = { "user": parts[0], "pass": parts[1] };
    return;
  }

  console.log( 'error: auth format wrong. must be user:password' );
  process.exit(0);
}

//KEEP
function FHEM(logInstance, config, server) {
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
    } else if(use_ssl) {
        base_url = 'https://';
    }
    base_url += this.server + ':' + this.port;

    if (config.webname) {
        base_url += '/' + config.webname;
    } else {
        base_url += '/fhem';
    }
    
    this.connection = {base_url: base_url, log: log, fhem: this};
    if (config['auth'])
      auth = config['auth'];
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
    var query = '?XHR=1'
        + '&inform=type=status;addglobal=1;filter=' + filter + ';since=' + since + ';fmt=JSON'
        + '&timestamp=' + Date.now();

    var url = encodeURI(connection.base_url + query);
    connection.log('starting longpoll: ' + url);

    var FHEM_longpollOffset = 0;
    var input = '';
    var request = require('request');
    connection.auth = FHEM_connectionAuth[connection.base_url];
    if (connection.auth)
      request = request.defaults({auth: connection.auth, rejectUnauthorized: false});
    request.get({url: url}).on('data', async function (data) {
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
                        connection.fhem.serverprocess.startConnection();
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
                  await dynfcts.FHEM_update(device, reading, readingSetting, value, REPORT_STATE);
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
        var timeout = 500 * FHEM_longpoll[connection.base_url].disconnects - 300;
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

//KEEP
FHEM.prototype.execute = function (cmd, callback) {
    FHEM_execute(this.connection, cmd, callback)
};

FHEM.prototype.execute_await = async function (cmd) {
  return await FHEM_execute_await(this.connection, cmd);
}

FHEM.prototype.reload = async function (n) {
  if (n)
      this.log.info('reloading ' + n + ' from ' + this.connection.base_url);
  else
      this.log.info('reloading ' + this.connection.base_url);

  if (n) {
      await this.connection.fhem.connect(undefined, 'NAME=' + n);
  } else {
      await this.connection.fhem.connect();
  }
}

function setLoginFailed(fhem, err) {
  fhem.execute('setreading ' + fhem.gassistant + ' gassistant-fhem-connection login failed, please retry');
  fhem.execute('setreading ' + fhem.gassistant + ' gassistant-fhem-lasterror ' + err);
  //fhem.execute('set ' + fhem.gassistant + ' loginURL ' + database.getUrl());
}

FHEM.prototype.getFhemGassistantDevice = function() {
  FHEM_execute(this.connection, "jsonlist2 TYPE=gassistant",
    function(res) {
      try {
        res = JSON.parse(res);
        this.log.info('FHEM Google Assistant device detected: ' + res.Results[0].Name);
        this.gassistant = res.Results[0].Name;
        gassistant = this.gassistant;
        database.setFhemDeviceInstance(this);
        var cmd = 'set ' + this.gassistant + ' loginURL ' + database.getUrl();
        this.execute(cmd);
        this.getRefreshToken(
          async function(refreshToken) {
            if (refreshToken) {
              this.execute('setreading ' + this.gassistant + ' gassistant-fhem-connection connecting...');
              database.setRefreshToken(refreshToken);
              this.log.info('Found refresh token in reading');
              try {
                await database.refreshAllTokens();
                this.log.info('refreshAllTokens executed');
                await this.connection.fhem.serverprocess.startConnection();
                this.log.info('start connection executed');
                this.execute('setreading ' + this.gassistant + ' gassistant-fhem-lasterror none');
                this.checkAndSetGenericDeviceType();
              } catch (err) {
                setLoginFailed(this, err);
              }
            } else
              this.setLoginRequired();
        }.bind(this));
      } catch (err) {
        this.log.error('Please define Google Assistant device in FHEM: define gassistant gassistant');
        process.exit(1);
      }
    }.bind(this));
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
      request = request.defaults({auth: this.connection.auth, rejectUnauthorized: false});
      
    var response = await request({url: url, json: true, gzip: true, resolveWithFullResponse: true});
    if (response.statusCode === 200) {
      var json = response.body;
      // log.info("got json: " + util.inspect(json));
      this.log.info('got: ' + json['totalResultsReturned'] + ' results');
      //TODO check results if they are different from previous ones (do not compare times!!)
      if (json['totalResultsReturned']) {
        var md5JSON = JSON.parse(JSON.stringify(json['Results']));
        for (var dev in md5JSON) {
          for (var i in md5JSON[dev].Internals) {
            if (['DEF', 'TYPE', 'id', 'SUBTYPE', 'inControllable', 'NAME', 'MODEL', 'modelid'].indexOf(i) <= 0) {
              delete md5JSON[dev].Internals[i];
            }
          }
          for (var r in md5JSON[dev].Readings) {
            md5JSON[dev].Readings[r] = {};
          }
          md5JSON[dev].PossibleSets = md5JSON[dev].PossibleSets.split(" ").sort();
          md5JSON[dev].PossibleAttrs = md5JSON[dev].PossibleAttrs.split(" ").sort();
        }
        var currmd5 = crypto.createHash('md5').update(JSON.stringify(md5JSON)).digest("hex");

        if (md5 !== currmd5) {
          try {
            await database.realdb.ref('users/' + database.getUid() + '/devices').remove();
            await database.realdb.ref('users/' + database.getUid() + '/readings').remove();
          } catch (err) {
            console.error('Realtime Database deletion failed: ' + err);
          }
  
          var batch = database.db.batch();
          
          //DELETE current data in database
          try {
            var ref = await database.db.collection(database.getUid()).doc('devices').collection('devices').get();
            for (var r of ref.docs) {
              batch.delete(r.ref);
            }
          } catch (err) {
            console.error('Device deletion failed: ' + err);
          }
          
          try {
            var ref = await database.db.collection(database.getUid()).doc('devices').collection('attributes').get();
            for (var r of ref.docs) {
              batch.delete(r.ref);
            }
          } catch (err) {
            console.error('Attribute deletion failed: ' + err);
          }
  
          var con = {base_url: this.connection.base_url};
          this.connection.auth = FHEM_connectionAuth[this.connection.base_url];
          if (this.connection.auth) {
            con.auth = this.connection.auth;
          }
  
          FHEM_activeDevices = {};
          json['Results'].map(function (s) {
            FHEM_activeDevices[s.Internals.NAME] = 1;
            batch.set(database.db.collection(database.getUid()).doc('devices').collection('devices').doc(s.Internals.NAME), {json: s, connection: con.base_url}, {merge: true});
          }.bind(this));
          await batch.commit();
          
          md5 = currmd5;
          initSync = 1;
          
          //send current readings database.updateDeviceReading
          FHEM_deviceReadings = await database.generateMappings();
          dynfcts.setDeviceReadings(FHEM_deviceReadings);
            
          json['Results'].map(function (s) {
            for (var reading in s.Readings) {
              if (FHEM_deviceReadings.hasOwnProperty(s.Internals.NAME) && FHEM_deviceReadings[s.Internals.NAME].hasOwnProperty(reading)) {
                const REPORT_STATE = 0;
                dynfcts.FHEM_update(s.Internals.NAME, reading, FHEM_deviceReadings[s.Internals.NAME][reading].format, s.Readings[reading].Value, REPORT_STATE);
              }
            }
          }.bind(this));
        } else {
          this.log.info("No changes, therefore no reload required.");
        }
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

FHEM.prototype.getRefreshToken = function(callback) {
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

FHEM.prototype.setLoginRequired = function() {
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
            var newGdtList = gdtList.filter(function(elem, pos) {
                return gdtList.indexOf(elem) == pos;
            });
            var l2 = newGdtList.length;
            if (l2 > l1) {
              if (l1>0)
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
    if( FHEM_csrfToken[connection.base_url] )
      url += '&fwcsrf=' + encodeURIComponent(FHEM_csrfToken[connection.base_url]);
    url += '&XHR=1';
    log.info( '  executing: ' + url );
    
    connection.auth = FHEM_connectionAuth[connection.base_url];
    var request = require('request');
    request = request.defaults({auth: connection.auth, rejectUnauthorized: false});

    request
        .get({url: url, gzip: true},
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
  if( FHEM_csrfToken[connection.base_url] )
    url += '&fwcsrf=' + encodeURIComponent(FHEM_csrfToken[connection.base_url]);
  url += '&XHR=1';
  log.info( '  executing: ' + url );
  
  connection.auth = FHEM_connectionAuth[connection.base_url];
  var headers = {
    'content-type': 'application/json'
  };
  if (connection.auth) {
    headers['Authorization'] = 'Basic ' + base64.encode(connection.auth.user + ':' + connection.auth.pass);
  }
  var res = await fetch(url, {headers: headers});
  return await res.json();
}


