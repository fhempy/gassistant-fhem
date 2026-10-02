'use strict';

// Google Home local fulfillment (Local Home SDK)
//
// 1. The Google speaker scans the network via mDNS for "fhemconnect._http._tcp.local".
// 2. The local home app (running on the speaker) forwards the IDENTIFY intent to this server,
//    we answer as hub (isProxy, isLocalOnly).
// 3. The speaker sends REACHABLE_DEVICES, we answer with the devices reachable via this hub.
//    verificationId must match the otherDeviceIds of the SYNC response (FHEM device name).
// 4. EXECUTE intents for these devices are sent directly to this server instead of the cloud.

const http = require('http');
const os = require('os');
const express = require('express');
const { Bonjour } = require('bonjour-service');
const localEXECUTE = require('./localhandleEXECUTE');
const database = require('./database');

const logger = require('./logger').Logger.withPrefix("LOCAL");

const DEFAULT_PORT = 37000;
const SERVICE_NAME = 'fhemconnect';
const LOCAL_PATH = '/fhemconnect/local';

var bonjour;
var localHomeStarted = false;

// mDNS host names must end with .local, otherwise the SRV target can't be resolved.
// Use an own host name, the system host name is already announced by avahi.
function mdnsHostname() {
  var host = os.hostname().split('.')[0].replace(/[^A-Za-z0-9-]/g, '-');
  return SERVICE_NAME + '-' + host + '.local';
}

// Device names reachable via this hub. They are equal to the otherDeviceIds of the SYNC response.
function getReachableDeviceIds(requestDevices) {
  var ids = new Set();
  if (Array.isArray(requestDevices) && requestDevices.length > 0) {
    // devices from the SYNC response, sent by the platform (deprecated in Local Home SDK 1.4)
    for (var d of requestDevices) {
      if (d && d.customData && typeof d.customData.device === 'string')
        ids.add(d.customData.device);
    }
  } else {
    var mappings = database.getMappings();
    for (var key of Object.keys(mappings)) {
      var def = mappings[key] && mappings[key]['XXXDEVICEDEFXXX'];
      if (def && typeof def.name === 'string')
        ids.add(def.name);
    }
  }
  return Array.from(ids);
}

function createApp(serverInstance) {
  var app = express();
  var localHomeState = 'inactive';
  var reachableCount;

  async function setActive() {
    if (localHomeState === 'active')
      return;
    localHomeState = 'active';
    await serverInstance.updateLocalHomeState('active');
  }

  // REACHABLE_DEVICES contains all SYNC devices, this can be large
  app.use(express.json({ limit: '10mb' }));

  app.post(LOCAL_PATH, async function (req, res) {
    var intent;
    try {
      intent = req.body && req.body.inputs && req.body.inputs[0] && req.body.inputs[0].intent;
      logger.info('LOCALHOME ' + (intent || 'invalid request') + ' from ' + req.ip);
      logger.debug('LOCALHOME request: ' + JSON.stringify(req.body));

      if (intent === "action.devices.IDENTIFY") {
        await setActive();
        res.send({
          requestId: req.body.requestId,
          intent: intent,
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
          }
        });
      } else if (intent === "action.devices.REACHABLE_DEVICES") {
        await setActive();
        var ids = getReachableDeviceIds(req.body.devices);
        if (ids.length !== reachableCount) {
          reachableCount = ids.length;
          logger.info('LOCALHOME reachable devices: ' + reachableCount);
          await serverInstance.updateLocalHomeDevices(reachableCount);
        }
        res.send({
          requestId: req.body.requestId,
          intent: intent,
          payload: {
            devices: ids.map(function (id) {
              return { verificationId: id };
            })
          }
        });
      } else if (intent === "action.devices.EXECUTE") {
        await setActive();
        logger.info('LOCALHOME received: ' + JSON.stringify(req.body));
        await localEXECUTE.handleEXECUTE(database.getUid(), req.body.requestId, res, req.body.inputs[0]);
      } else {
        logger.info('LOCALHOME unknown command received: ' + intent);
        res.send({
          requestId: req.body && req.body.requestId,
          intent: intent,
          payload: {
            errorCode: 'notSupported'
          }
        });
      }
    } catch (err) {
      logger.error('Error in Local Home (' + intent + '): ' + (err && err.stack ? err.stack : err));
      if (!res.headersSent)
        res.status(500).send({ error: String(err) });
    }
  });

  // e.g. request too large or invalid JSON
  app.use(function (err, req, res, next) {
    logger.error('LOCALHOME invalid request from ' + req.ip + ': ' + err.message);
    res.status(err.status || 500).send({ error: err.message });
  });

  return app;
}

function startLocalHome(serverInstance) {
  if (localHomeStarted)
    return;
  localHomeStarted = true;

  serverInstance.updateLocalHomeState('inactive');

  var server = http.createServer(createApp(serverInstance));
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

  var host = mdnsHostname();
  // advertise an HTTP server on port PORT
  bonjour.publish({
    name: SERVICE_NAME,
    type: 'http',
    host: host,
    port: serverPort,
    txt: {
      httpPath: LOCAL_PATH,
      httpSSL: 'false',
      httpPort: String(serverPort),
      version: '1.0'
    }
  }).on("up", function () {
    logger.info("Bonjour successfully published: " + SERVICE_NAME + "._http._tcp.local -> " + host + ":" + serverPort);
    logger.info("Local Home ready, waiting for Google devices...");
  });
}

module.exports = {
  startLocalHome,
  createApp,
  getReachableDeviceIds
};
