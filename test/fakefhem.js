'use strict';

// Minimal FHEMWEB simulation for tests
const http = require('http');

function createFakeFhem(opts) {
  opts = opts || {};
  const commands = [];
  const longpolls = [];
  const server = http.createServer(function (req, res) {
    const u = new URL(req.url, 'http://localhost');
    if (opts.auth) {
      const expected = 'Basic ' + Buffer.from(opts.auth).toString('base64');
      if (req.headers.authorization !== expected) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fhem"' });
        return res.end();
      }
    }
    if (u.searchParams.get('inform')) {
      res.writeHead(200, { 'X-FHEM-csrfToken': 'csrf123', 'Content-Type': 'text/plain' });
      res.flushHeaders();
      longpolls.push(res);
      return;
    }
    const cmd = u.searchParams.get('cmd');
    commands.push({ cmd: cmd, csrf: u.searchParams.get('fwcsrf') });
    const answer = opts.answer ? opts.answer(cmd) : '';
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(answer === undefined ? '' : answer);
  });
  return new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', function () {
      resolve({
        server,
        port: server.address().port,
        commands,
        longpolls,
        close: function () {
          longpolls.forEach(function (r) { r.destroy(); });
          server.closeAllConnections();
          return new Promise(function (r) { server.close(r); });
        }
      });
    });
  });
}

module.exports = { createFakeFhem };
