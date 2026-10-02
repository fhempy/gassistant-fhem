'use strict';

const express = require('express');
const localEXECUTE = require('./localhandleEXECUTE');
const database = require('./database');

const logger = require('./logger').Logger.withPrefix("LOCAL");

const DEFAULT_PORT = 37000;

function startLocalHome(serverInstance) {
  var app = express();
  var inactiveTimer = 0;
  var activeReadingSet = 0;

  serverInstance.updateLocalHomeState('inactive');

  app.use(express.json());

  app.post('/fhemconnect/local', async function (req, res) {
    try {
      if (req.body.inputs[0].intent == "action.devices.IDENTIFY") {
        var resp = {
          requestId: req.body.requestId,
          payload: {
            device: {
              id: 'fhemconnect-id',
              isLocalOnly: true,
              isProxy: true,
              deviceInfo: {
                hwVersion: "UNKNOWN_HW_VERSION",
                manufacturer: "FHEM Connect",
                model: "FHEM Connect",
                swVersion: "1.0"
              }
            }
          },
          intent: "action.devices.IDENTIFY"
        };

        res.send(resp);
      } else if (req.body.inputs[0].intent == "action.devices.REACHABLE_DEVICES") {
        //set local home state reading
        if (inactiveTimer) {
          clearTimeout(inactiveTimer);
        }
        if (activeReadingSet === 0) {
          await serverInstance.updateLocalHomeState('active');
          activeReadingSet = 1;
        }
        inactiveTimer = setTimeout(async function () { activeReadingSet = 0; await serverInstance.updateLocalHomeState('inactive'); }, 300000);

        //create response for reachable_devices
        var verifiedDevices = [];
        req.body.devices.forEach(d => {
          if (typeof d.customData.device !== 'undefined') {
            verifiedDevices.push({
              verificationId: d.id
            });
          }
        });

        var resp = {
          requestId: req.body.requestId,
          payload: {
            devices: verifiedDevices
          },
          intent: "action.devices.REACHABLE_DEVICES"
        };

        res.send(resp);
      } else if (req.body.inputs[0].intent == "action.devices.EXECUTE") {
        logger.info('LOCALHOME received: ' + JSON.stringify(req.body));
        localEXECUTE.handleEXECUTE(database.getUid(), req.body.requestId, res, req.body.inputs[0]);
      } else {
        //FIXME
        logger.info('LOCALHOME unknown command received: ' + req.body.inputs[0].intent);
        res.send("ERROR");
      }
    } catch (err) {
      logger.error('Error in Local Home: ' + err);
    }
  });

  var server = app.listen(DEFAULT_PORT, "0.0.0.0", function () {
    startBonjour(server.address().port);
  }).on('error', function (err) {
    if (err.errno === 'EADDRINUSE') {
      logger.info("Default port in use, try different.");
      server = app.listen(0, "0.0.0.0", function () {
        startBonjour(server.address().port);
      });
    } else {
      logger.info(err);
    }
  });
}

function startBonjour(serverPort) {
  logger.info('FHEM Connect Google local home server running on port ' + serverPort);

  var bonjour = require('bonjour')();
  // advertise an HTTP server on port PORT
  var srv = bonjour.publish({
    name: 'fhemconnect',
    type: 'http',
    port: serverPort,
    txt: {
      httpPath: '/fhemconnect/local',
      httpSSL: false,
      httpPort: serverPort,
      version: '1.0'
    }
  }).on("error", function (err) {
    logger.error("Can't start bonjour service: " + err);
    logger.error("===> LOCAL HOME WON'T WORK <===");
    logger.error("Retry in 5 minutes...");
    setTimeout(function () { startBonjour(serverPort) }, 300000);
    return undefined;
  }).on("up", function() {
    logger.info("Bonjour successfully published");
    logger.info("Local Home ready");
  });

  srv.start();
}

module.exports = {
  startLocalHome
};