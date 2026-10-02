'use strict';

// Minimal HTTP client for FHEMWEB, replaces the deprecated request/request-promise packages.
// FHEM often uses self signed certificates, therefore certificate validation is disabled
// for FHEM connections (same behaviour as before with request's rejectUnauthorized: false).

const http = require('http');
const https = require('https');

const DEFAULT_TIMEOUT = 60000;

function buildOptions(url, auth) {
  const u = new URL(url);
  const options = {
    method: 'GET',
    headers: {}
  };
  if (u.protocol === 'https:')
    options.rejectUnauthorized = false;
  if (auth && auth.user !== undefined)
    options.headers['Authorization'] = 'Basic ' + Buffer.from(auth.user + ':' + (auth.pass || '')).toString('base64');
  return { u, options };
}

function clientFor(u) {
  return u.protocol === 'https:' ? https : http;
}

// Streaming GET request (used for longpoll). Returns the ClientRequest, call destroy() to abort.
// handlers: { response(res), data(chunk), close(err) } - close is called exactly once.
function stream(url, auth, handlers) {
  const { u, options } = buildOptions(url, auth);
  let closed = false;
  function close(err) {
    if (closed)
      return;
    closed = true;
    if (handlers.close)
      handlers.close(err);
  }

  const req = clientFor(u).request(u, options, function (res) {
    if (handlers.response)
      handlers.response(res);
    if (res.statusCode !== 200) {
      res.resume();
      close(new Error('HTTP ' + res.statusCode + ' ' + res.statusMessage));
      return;
    }
    res.setEncoding('utf8');
    res.on('data', function (chunk) {
      if (handlers.data)
        handlers.data(chunk);
    });
    res.on('error', close);
    res.on('close', function () {
      close(res.complete ? undefined : new Error('connection closed'));
    });
  });
  req.on('error', close);
  req.end();
  return req;
}

// Simple GET request, resolves with { statusCode, statusMessage, headers, body }.
function get(url, auth, timeout) {
  const { u, options } = buildOptions(url, auth);
  return new Promise(function (resolve, reject) {
    const req = clientFor(u).request(u, options, function (res) {
      res.setEncoding('utf8');
      let body = '';
      res.on('data', function (chunk) {
        body += chunk;
      });
      res.on('end', function () {
        resolve({
          statusCode: res.statusCode,
          statusMessage: res.statusMessage,
          headers: res.headers,
          body: body
        });
      });
      res.on('error', reject);
    });
    req.setTimeout(timeout || DEFAULT_TIMEOUT, function () {
      req.destroy(new Error('timeout after ' + (timeout || DEFAULT_TIMEOUT) + 'ms'));
    });
    req.on('error', reject);
    req.end();
  });
}

module.exports = {
  get,
  stream
};
