'use strict';

const fs = require('fs');
const version = require('./version');
const User = require('./user').User;
const log = require("./logger")._system;
const Logger = require('./logger').Logger;
const FHEM = require('./fhem').FHEM;
const FHEM_execute = require('./fhem').FHEM_execute;
const FHEM_getClientFunctions = require('./fhem').FHEM_getClientFunctions;
const database = require('./database');
const dynfcts = require('./dynamicfunctions');

module.exports = {
    Server: Server
}

function Server() {
    this._config = this._loadConfig();
}

Server.prototype._loadConfig = function () {

    // Load up the configuration file
    let config;
    // Look for the configuration file
    const configPath = User.configPath();
    log.info("using " + configPath);
    
    // Complain and exit if it doesn't exist yet
    if (!fs.existsSync(configPath)) {
        log.error("Couldn't find config.json at " + configPath + ", using default values.");
        config =
          {
              "connections": [
                  {
                      "name": "FHEM",
                      "server": "127.0.0.1",
                      "port": "8083",
                      "webname": "fhem",
                      "filter": "room=GoogleAssistant"
                  }
              ]
          };
    } else {
      try {
          config = JSON.parse(fs.readFileSync(configPath));
      }
      catch (err) {
          log.error("There was a problem reading your config.json file.");
          log.error("Please try pasting your config.json file here to validate it: http://jsonlint.com");
          log.error("");
          throw err;
      }
    }

    log.info("---");
    log.info('config:\n' + JSON.stringify(config) + '\n');
    log.info("---");

    return config;
}

Server.prototype.startServer = function () {
    dynfcts.registerFirestoreListener.bind(this)();
}

Server.prototype.run = function () {
    log.info('Google Assistant FHEM Connect ' + version + ' started');

    if (!this._config.connections) {
        log.error('no connections in config file');
        process.exit(-1);
    }
    
    log.info('Fetching FHEM connections...');

    this.devices = {};
    this.connections = [];
    var fhem;
    for (var connection of this._config.connections) {
        fhem = new FHEM(Logger.withPrefix(connection.name), connection, this);

        this.connections.push(fhem);
    }
}

Server.prototype.startConnection = async function() {
  await dynfcts.FHEM_getClientFunctions();
  database.reportClientVersion();
  database.clientHeartbeat();
  
  //register listener
  this.startServer();
  //load devices
  this.roomOfIntent = {};
  for (var fhem of this.connections) {
    fhem.connect();
  }
  
  dynfcts.checkFeatureLevel.bind(this)();
}


var log2 = function (title, msg) {

    console.log('**** ' + title + ': ' + JSON.stringify(msg));

}// log
