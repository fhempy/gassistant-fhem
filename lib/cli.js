var program = require('commander');
var version = require('./version');
var Server = require('./server').Server;
var User = require('./user').User;
var log = require("./logger")._system;
var FHEM = require('./fhem').FHEM;
var database = require('./database');

'use strict';

module.exports = function () {

  program
    .version(version)
    .option('-D, --debug', 'turn on debug level logging', function () {
      require('./logger').setDebugEnabled(true)
    })
    .option('-c, --config [path]', 'location of the config file', function (p) {
      User.setConfigPath(p)
    })
    .option('-a, --auth [auth]', 'user:password for FHEM connection', function (auth) {
      FHEM.auth(auth)
    })
    .option('-s, --ssl', 'use https for FHEM connection', function () {
      FHEM.useSSL(true)
    })
    .parse(process.argv);

  var server = new Server();

  var signals = {
    'SIGINT': 2,
    'SIGTERM': 15
  };
  Object.keys(signals).forEach(function (signal) {
    process.on(signal, async function () {
      log.info("Got %s, shutting down...", signal);
      try {
        await database.clientShutdown();
      } catch (err) {
        //do nothing
      }
      process.exit(128 + signals[signal]);
    });
  });

  server.run();
}