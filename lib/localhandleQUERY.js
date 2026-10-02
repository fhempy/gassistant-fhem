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
  try {
    // functions are delivered as source code by the server and evaluated in the scope of this module
    var fcts = await database.gethandleQUERY();
    for (var f in fcts) {
      var loadFctStr = f + '=' + fcts[f];
      eval(loadFctStr);
    }
  } catch (err) {
    logger.error('Failed to load client functions: ' + err);
  }

  clientFunctionTimeout = setTimeout(FHEM_getClientFunctions, 1209600000); //update every 14 days
}
