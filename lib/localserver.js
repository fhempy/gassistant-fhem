'use strict';

const http = require('http');
const express = require('express');
const { Bonjour } = require('bonjour-service');
const localEXECUTE = require('./localhandleEXECUTE');
const database = require('./database');

const logger = require('./logger').Logger.withPrefix("LOCAL");

const DEFAULT_PORT = 37000;

var bonjour;
var localHomeStarted = false;

function startLocalHome(serverInstance) {
  if (localHomeStarted)
    return;
  localHomeStarted = true;

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
        await localEXECUTE.handleEXECUTE(database.getUid(), req.body.requestId, res, req.body.inputs[0]);
      } else {
        //FIXME
        logger.info('LOCALHOME unknown command received: ' + req.body.inputs[0].intent);
        res.send("ERROR");
      }
    } catch (err) {
      logger.error('Error in Local Home: ' + err);
      if (!res.headersSent)
        res.status(500).send("ERROR");
    }
  });

  var server = http.createServer(app);
  server.on('listening', function () {
    startBonjour(server.address().port);
  });
  server.on('error', function (err) {
    if (err.code === 'EADDRINUSE' && server.address() === null) {
      logger.info("Default port in use, try different.");
      server.listen(0, "0.0.0.0");
    } else {
      logger.error('Local Home server error: ' + err);
    }
  });
  server.listen(DEFAULT_PORT, "0.0.0.0");
}

function startBonjour(serverPort) {
  logger.info('FHEM Connect Google local home server running on port ' + serverPort);

  if (!bonjour) {
    bonjour = new Bonjour({}, function (err) {
      logger.error("Bonjour error: " + err);
    });
    // mdns socket errors must not crash the process
    bonjour.server.mdns.on('error', function (err) {
      logger.error("Can't start bonjour service: " + err);
      logger.error("===> LOCAL HOME WON'T WORK <===");
    });
  } else {
    bonjour.unpublishAll();
  }

  // advertise an HTTP server on port PORT
  bonjour.publish({
    name: 'fhemconnect',
    type: 'http',
    port: serverPort,
    txt: {
      httpPath: '/fhemconnect/local',
      httpSSL: 'false',
      httpPort: String(serverPort),
      version: '1.0'
    }
  }).on("up", function () {
    logger.info("Bonjour successfully published");
    logger.info("Local Home ready");
  });
}

module.exports = {
  startLocalHome
};