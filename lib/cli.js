'use strict';

const { Command } = require('commander');
const version = require('./version');
const Server = require('./server').Server;
const User = require('./user').User;
const logger = require('./logger');
const log = logger._system;
const FHEM = require('./fhem').FHEM;
const database = require('./database');

module.exports = function () {
  const program = new Command();

  program
    .name('gassistant-fhem')
    .version(version)
    .option('-D, --debug', 'turn on debug level logging')
    .option('-c, --config <path>', 'location of the config file')
    .option('-a, --auth <auth>', 'user:password for FHEM connection')
    .option('-s, --ssl', 'use https for FHEM connection')
    .parse(process.argv);

  const options = program.opts();
  if (options.debug)
    logger.setDebugEnabled(true);
  if (options.config)
    User.setConfigPath(options.config);
  if (options.auth)
    FHEM.auth(options.auth);
  if (options.ssl)
    FHEM.useSSL(true);

  // keep the client running if a single request fails somewhere
  process.on('unhandledRejection', function (reason) {
    log.error('Unhandled promise rejection: ' + (reason && reason.stack ? reason.stack : reason));
  });

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
