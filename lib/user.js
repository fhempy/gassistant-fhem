var path = require('path');
var fs = require('fs');

'use strict';

module.exports = {
  User: User
}

/**
 * Manages user settings and storage locations.
 */

// global cached config
var config;

// optional custom storage path
var customStoragePath;
var configPath;

function User() {}

User.config = function () {
  return config || (config = Config.load(User.configPath()));
}

User.storagePath = function () {
  if (customStoragePath) return customStoragePath;
  var home = process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE || '/home/pi';
  return path.join(home, ".fhemconnect");
}

User.configPath = function () {
  return configPath ? configPath : path.join(User.storagePath(), "gassistant-fhem.cfg");
}

User.persistPath = function () {
  return path.join(User.storagePath(), "persist");
}

User.setStoragePath = function (path) {
  customStoragePath = path;
}

User.setConfigPath = function (path) {
  configPath = path;
}