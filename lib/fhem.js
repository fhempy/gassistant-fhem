
const path = require('path');
var request = require('sync-request');
var {NodeVM} = require('vm2');
const settings = require('./settings.json');

function getModule() {
  const remotefile = 'fhem.js';
  console.log('Loading ' + remotefile + '...');
  var req = request("GET", settings.HOSTING_URL + remotefile);
  var txt = req.getBody().toString();
  const vm = new NodeVM({sandbox: {require, process}, require: { external: true, builtin: ["*"]}});
  return vm.run(txt, path.join(__dirname, "remote-" + remotefile));
}

module.exports = getModule();
