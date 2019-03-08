const settings = require('./settings.json');
const database = require('./database');
const fhem = require('./fhem');

var FHEM_devReadingVal = {};
var FHEM_reportStateStore = {};
var FHEM_deviceReadings = {};

const CLOUD_FUNCTIONS_BASE = settings.CLOUD_FUNCTIONS_BASE;

exports.setDeviceReadings = function(deviceReadings) {
  FHEM_deviceReadings = deviceReadings;
}

exports.FHEM_getClientFunctions = async function FHEM_getClientFunctions() {
  var fcts = await database.getClientFunctions();
  for (var f in fcts) {
    var loadFctStr = f + '=' + fcts[f];
    eval(loadFctStr);
  }
}
