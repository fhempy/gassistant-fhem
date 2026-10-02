const settings = require('./settings.json');
var database = require('./database');
var utils = require('./utils');
var fhem2 = require('./fhem');
const uidlog = require('./logger').nouidlog;
const uiderror = require('./logger').uiderror;

const logger = require('./logger')._system;

var clientFunctionTimeout = 0;

exports.FHEM_getClientFunctions = async function FHEM_getClientFunctions() {
  if (clientFunctionTimeout) {
    clearTimeout(clientFunctionTimeout);
  }
  var fcts = await database.gethandleQUERY();
  for (var f in fcts) {
    var loadFctStr = f + '=' + fcts[f];
    eval(loadFctStr);
  }

  clientFunctionTimeout = setTimeout(FHEM_getClientFunctions, 1209600000); //update every 14 days
}
