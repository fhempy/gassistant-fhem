'use strict';

const fs = require('fs');
const path = require('path');
const version = require('./version');
const User = require('./user').User;
const log = require("./logger")._system;
const Logger = require('./logger').Logger;
const FHEM = require('./fhem').FHEM;
const database = require('./database');
const localhome = require('./localserver');
const localEXECUTE = require('./localhandleEXECUTE');
const localQUERY = require('./localhandleQUERY');


module.exports = {
  Server: Server,
  configForLog: configForLog
}

var firebaseListenerRegistered = false;

function Server() {
  this._config = this._loadConfig();
}

Server.prototype._loadConfig = function () {

  // Load up the configuration file
  let config;
  // Look for the configuration file
  const configPath = User.configPath();
  log.info("using " + configPath);

  // Complain and create a default config if it doesn't exist yet
  if (!fs.existsSync(configPath)) {
    log.error("Couldn't find config.json at " + configPath + ", using default values.");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    config = {
      "connections": [{
        "name": "FHEM",
        "server": "127.0.0.1",
        "port": "8083",
        "webname": "fhem",
        "filter": "room=GoogleAssistant"
      }]
    };
    fs.writeFileSync(configPath, JSON.stringify(config));
  } else {
    try {
      config = JSON.parse(fs.readFileSync(configPath));
    } catch (err) {
      log.error("There was a problem reading your config.json file.");
      log.error("Please try pasting your config.json file here to validate it: http://jsonlint.com");
      log.error("");
      throw err;
    }
  }

  log.info("---");
  log.info('config:\n' + JSON.stringify(configForLog(config)));
  log.info("---");

  return config;
}

// copy of the config without credentials
function configForLog(config) {
  var logConfig = JSON.parse(JSON.stringify(config));
  if (logConfig.auth)
    logConfig.auth = "auth used";
  if (Array.isArray(logConfig.connections)) {
    for (var connection of logConfig.connections) {
      if (connection && connection.auth)
        connection.auth = "auth used";
    }
  }
  return logConfig;
}

Server.prototype.startServer = async function () {
  await registerFirestoreListener.bind(this)();
}

async function handler(event, callback) {
  if (!event.msg) {
    //something was deleted in firestore, no need to handle
    return;
  }

  log.info("Received firestore2fhem: " + JSON.stringify(event));

  try {

    switch (event.msg) {

      case 'EXECUTE':
        require('./fhem').FHEM_execute({
          base_url: event.connection
        }, event.cmd);
        break;

      case 'REPORTSTATEALL':
        setTimeout(require('./database').reportStateAll, parseInt(event.delay) * 1000);
        break;

      case 'UPDATE_SYNCFEATURELEVEL':
        for (var fhem of this.connections) {
          fhem.execute('setreading ' + fhem.gassistant + ' gassistant-fhem-usedFeatureLevel ' + event.featurelevel);
          fhem.execute('setreading ' + fhem.gassistant + ' gassistant-fhem-googleSync Google SYNC finished');
        }
        break;

      case 'UPDATE_SERVERFEATURELEVEL':
        for (var fhem of this.connections) {
          fhem.execute('setreading ' + fhem.gassistant + ' gassistant-fhem-availableFeatureLevel ' + event.featurelevel);
        }
        break;

      case 'LOG_ERROR':
        for (var fhem of this.connections) {
          fhem.execute('setreading ' + fhem.gassistant + ' gassistant-fhem-lastServerError ' + event.log);
        }
        break;

      case 'UPDATE_CLIENT':
        log.info("#################################################");
        log.info("#################################################");
        log.info("#################################################");
        log.info("#################################################");
        log.info("!!!!!!!!PLEASE UPDATE YOUR CLIENT ASAP!!!!!!!!!!!");
        log.info("#################################################");
        log.info("#################################################");
        log.info("#################################################");
        log.info("#################################################");
        break;

      case 'STOP_CLIENT':
        process.exit(1);
        break;

      default:
        log.info("Error: Unsupported event", event);

        //TODO response = handleUnexpectedInfo(requestedNamespace);

        break;

    } // switch

  } catch (error) {

    log.error(error);

  } // try-catch

  //return response;

} // exports.handler

async function registerFirestoreListener() {
  if (firebaseListenerRegistered)
    return undefined;

  //delete old messages
  try {
    await database.deleteFirestore2FhemMessages();
  } catch (err) {
    log.error('Failed to delete firestore2fhem messages: ' + err);
  }

  try {
    database.onFirestore2FhemMessage((data) => {
      log.info('GOOGLE MSG RECEIVED: ' + JSON.stringify(data));
      if (data && data.ts) {
        if (data.ts > (Date.now() - 10000)) {
          handler.bind(this)(data);
        } else {
          log.error('  Received message is older than 10s, therefore it gets discarded. Please check your date/time settings if you think that the messages is not that old.');
        }
      }
    });
    firebaseListenerRegistered = true;
  } catch (err) {
    log.error('onSnapshot failed: ' + err);
  }
}

Server.prototype.run = function () {
  log.info('Google Assistant FHEM Connect ' + version + ' started');

  if (!this._config.connections) {
    log.error('no connections in config file');
    process.exit(-1);
  }

  database.initFirebase();

  log.info('Fetching FHEM connections...');

  this.devices = {};
  this.connections = [];
  var fhem;
  for (var connection of this._config.connections) {
    fhem = new FHEM(Logger.withPrefix(connection.name), connection, this);

    this.connections.push(fhem);
  }
}

Server.prototype.startConnection = async function () {
  log.info('Start Connection and listen for Firebase');
  database.reportClientVersion().catch(function (err) {
    log.error('Failed to report client version: ' + err);
  });
  database.clientHeartbeat();

  localhome.startLocalHome(this);
  await localEXECUTE.FHEM_getClientFunctions();
  await localQUERY.FHEM_getClientFunctions();

  //register listener
  this.startServer().catch(function (err) {
    log.error('Failed to register Firestore listener: ' + err);
  });
  //load devices
  this.roomOfIntent = {};
  this.connectAll().catch(function (err) {
    log.error('Failed to load devices: ' + err);
  });

  checkFeatureLevel.bind(this)();
}

Server.prototype.updateLocalHomeState = async function (state) {
  for (var fhem of this.connections) {
    await fhem.setLocalHomeState(state);
  }
}

Server.prototype.updateLocalHomeDevices = async function (count) {
  for (var fhem of this.connections) {
    await fhem.setLocalHomeDevices(count);
  }
}

Server.prototype.connectAll = async function () {
  for (var fhem of this.connections) {
    await fhem.connect();
  }
  // SYNC only if the devices changed since the last SYNC
  await require('./sync').get().requestSync();

  await localEXECUTE.FHEM_getClientFunctions();
  await localQUERY.FHEM_getClientFunctions();
}

async function checkFeatureLevel() {
  try {
    var server = await database.getServerFeatureLevel();
    var sync = await database.getSyncFeatureLevel();
    log.info('SERVER FeatureLevel:' + JSON.stringify(server));
    log.info('SYNC   FeatureLevel:' + JSON.stringify(sync));

    if (server.featurelevel > sync.featurelevel) {
      //set changelog
      log.info('>>> VERSION UPGRADE STARTED');
      // reload SYNCs, also if the devices didn't change
      require('./sync').get().forceNext();
      for (var fhem of this.connections) {
        await fhem.reload();
      }
      log.info('>>> VERSION UPGRADE FINISHED - SYNC INITIATED');
    }
  } catch (err) {
    log.error('Feature level check failed: ' + err);
  }

  //update every 1-4 days
  setTimeout(checkFeatureLevel.bind(this), 86400000 + Math.floor(Math.random() * Math.floor(259200000)));
}