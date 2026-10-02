//FIXME shouldn't be here
const CLIENT_VERSION = "4.0";

const crypto = require('crypto');
const { initializeApp } = require('firebase/app');
const { getAuth, signInWithCustomToken } = require('firebase/auth');
const {
  getFirestore, collection, doc, setDoc, addDoc, getDoc, getDocs, deleteDoc,
  writeBatch, onSnapshot, query, limit
} = require('firebase/firestore');
const { getDatabase, ref, set, get, remove } = require('firebase/database');
const settings = require('./settings.json');
const versionnr = require('./version');
const log = require("./logger")._system;

const CLOUD_FUNCTIONS_BASE = settings.CLOUD_FUNCTIONS_BASE;
const CLOUD_FUNCTIONS_BASE_US = CLOUD_FUNCTIONS_BASE.replace('europe-west1', 'us-central1');
const CODE_REDIRECT_URI = CLOUD_FUNCTIONS_BASE + "/codelanding/start";
const FB_CUSTOM_TOKEN_URI = CLOUD_FUNCTIONS_BASE + "/firebase/token";
const GET_CLIENT_FUNCTIONS = CLOUD_FUNCTIONS_BASE + "/dynamicfunctionsv1/getdynamicfunctions";
const NPM_LATEST_URI = "https://registry.npmjs.org/gassistant-fhem/latest";
const AUDIENCE_URI = settings.AUDIENCE_URI;
const CLIENT_ID = settings.CLIENT_ID;
const AUTH0_DOMAIN = settings.AUTH0_DOMAIN;

// Firestore batches are limited to 500 operations
const BATCH_SIZE = 400;
const TOKEN_REFRESH_RETRY = 60000;
const SHUTDOWN_TIMEOUT = 3000;

var fbApp;
var fbAuth;

var db;
var realdb;

var all_tokens = {};
var heartbeat;
var _fhem;
var mappings = {};

function setMappings(m) {
  mappings = m || {};
}

function getMappings() {
  return mappings;
}

function getUid() {
  return all_tokens.uid;
};

// Firebase keys must not contain . # [ ] $
function escapeKey(key) {
  return key.replace(/\.|\#|\[|\]|\$/g, '_');
}

var verifier;
var refreshTimer;

function initFirebase() {
  fbApp = initializeApp(settings.firebase);
  fbAuth = getAuth(fbApp);
  db = getFirestore(fbApp);
  realdb = getDatabase(fbApp);
}

function scheduleTokenRefresh(expires_in) {
  if (refreshTimer)
    clearTimeout(refreshTimer);
  var seconds = parseInt(expires_in);
  if (isNaN(seconds))
    seconds = 3600;
  refreshTimer = setTimeout(async function refresh() {
    try {
      await refreshAllTokens();
    } catch (err) {
      log.error('Token refresh failed, retry in ' + (TOKEN_REFRESH_RETRY / 1000) + ' seconds: ' + err);
      refreshTimer = setTimeout(refresh, TOKEN_REFRESH_RETRY);
    }
  }, Math.max(seconds - 600, 60) * 1000);
}

async function checkLatestVersion() {
  try {
    var res = await fetch(NPM_LATEST_URI);
    if (!res.ok)
      throw new Error('HTTP ' + res.status);
    var data = await res.json();
    if (_fhem) {
      _fhem.execute('setreading ' + _fhem.gassistant + ' gassistant-fhem-versionAvailable ' + data.version);
    }
  } catch (err) {
    log.error('Failed to get latest version from npmjs.org: ' + err);
  }
}

async function refreshAllTokens() {
  if (!all_tokens.refresh) {
    log.error('No refresh token found.');
    log.error('Delete the token file and start the process again');
    process.exit(1);
  }

  checkLatestVersion();

  var auth0_tokens = await refreshToken(all_tokens.refresh);
  var firebase_token = await createFirebaseCustomToken(auth0_tokens.access);
  await signInWithCustomToken(fbAuth, firebase_token.firebase);

  log.info('Refresh tokens finished. Next refresh in ' + auth0_tokens.expires_in + ' seconds.');
  scheduleTokenRefresh(auth0_tokens.expires_in);

  all_tokens = {
    access: auth0_tokens.access,
    id: auth0_tokens.id,
    refresh: all_tokens.refresh,
    firebase: firebase_token.firebase,
    uid: firebase_token.uid
  };
  return;
}

async function postCloudFunction(functionUrl, body) {
  if (!body)
    body = '';

  return await callCloudFunction(functionUrl, 'POST', body);
}

async function getCloudFunction(functionUrl) {
  return await callCloudFunction(functionUrl, 'GET', '');
}

// Returns the parsed JSON response or {} on any error
async function callCloudFunction(functionUrl, method, body) {
  function options() {
    var o = {
      method: method,
      headers: {
        'Authorization': 'Bearer ' + all_tokens.access,
        'content-type': 'application/json'
      }
    };
    if (body)
      o.body = body;
    return o;
  }

  try {
    var res = await fetch(functionUrl, options());

    if (res.status == 401) {
      await refreshAllTokens();
      // use the new access token
      res = await fetch(functionUrl, options());
    }

    if (res.status != 200) {
      log.error('ERROR: ' + functionUrl + ' => ' + res.status + ':' + await res.text());
      return {};
    }

    return await res.json();
  } catch (err) {
    log.error('ERROR: ' + functionUrl + ' => ' + err);
    return {};
  }
}

async function deleteUserAccount() {
  var res = await getCloudFunction(CLOUD_FUNCTIONS_BASE + "/api/deleteuseraccount");
  all_tokens = {};
  return res;
}

async function getConfiguration() {
  return await getCloudFunction(CLOUD_FUNCTIONS_BASE + "/api/getconfiguration");
}

async function getClientFunctions() {
  return await getCloudFunction(GET_CLIENT_FUNCTIONS);
}

async function gethandleEXECUTE() {
  return await getCloudFunction(CLOUD_FUNCTIONS_BASE + "/dynamicfunctionsv1/4.0/gethandleEXECUTE");
}

async function gethandleQUERY() {
  return await getCloudFunction(CLOUD_FUNCTIONS_BASE + "/dynamicfunctionsv1/4.0/gethandleQUERY");
}

async function getServerFeatureLevel() {
  return await getCloudFunction(CLOUD_FUNCTIONS_BASE + "/api/getfeaturelevel");
}

async function getSyncFeatureLevel() {
  return await getCloudFunction(CLOUD_FUNCTIONS_BASE + "/api/getsyncfeaturelevel");
}

async function reportState(device) {
  log.info('reportstate: ' + device);
  return await postCloudFunction(CLOUD_FUNCTIONS_BASE_US + "/reportstate/singledevice", JSON.stringify({
    device: device
  }));
};

async function reportStateWithData(data) {
  log.info('reportstate_v2: ' + JSON.stringify(data));
  return await postCloudFunction(CLOUD_FUNCTIONS_BASE_US + "/reportstate/singledevice_v2", JSON.stringify({ deviceStatus: data }));
};

async function reportStateAll() {
  log.info('reportstate: all');
  return await getCloudFunction(CLOUD_FUNCTIONS_BASE_US + "/reportstate/alldevices");
};

async function initiateSync() {
  return await postCloudFunction(CLOUD_FUNCTIONS_BASE + "/api/initsync");
}

async function generateMappings(devicesJSON) {
  return await postCloudFunction(CLOUD_FUNCTIONS_BASE + "/api/3.0/genmappings", JSON.stringify(devicesJSON));
};

async function clientHeartbeat() {
  clearTimeout(heartbeat);
  try {
    await set(ref(realdb, 'users/' + all_tokens.uid + '/heartbeat'), {
      active: 1,
      time: Date.now()
    });
  } catch (err) {
    log.error('Heartbeat failed: ' + err);
  }
  heartbeat = setTimeout(clientHeartbeat, 60000);
}

function withTimeout(promise, ms) {
  var timer;
  return Promise.race([
    promise,
    new Promise(function (resolve) {
      timer = setTimeout(resolve, ms);
    })
  ]).finally(function () {
    clearTimeout(timer);
  });
}

async function clientShutdown() {
  clearTimeout(heartbeat);
  clearTimeout(refreshTimer);
  var tasks = [];
  if (_fhem) {
    tasks.push(_fhem.execute_await('setreading ' + _fhem.gassistant + ' gassistant-fhem-connection disconnected'));
    tasks.push(_fhem.execute_await('deletereading ' + _fhem.gassistant + ' gassistantFHEM.loginURL'));
  }
  if (realdb && all_tokens.uid) {
    tasks.push(set(ref(realdb, 'users/' + all_tokens.uid + '/heartbeat'), {
      active: 0,
      time: Date.now()
    }));
  }
  await withTimeout(Promise.allSettled(tasks), SHUTDOWN_TIMEOUT);
}

async function reportClientVersion() {
  await setDoc(doc(db, all_tokens.uid, 'client'), {
    version: CLIENT_VERSION,
    packageversion: versionnr
  }, {
    merge: true
  });
}

async function sendToFirestore(msg, id) {
  await addDoc(collection(db, all_tokens.uid, 'msgs', 'fhem2firestore'), {
    msg: msg,
    id: id
  });
}

async function setDeviceAttribute(device, attr, val) {
  await setDoc(doc(db, all_tokens.uid, 'devices', 'devices', device), {
    [attr]: val
  }, {
    merge: true
  });
};

async function getDeviceAttribute(device, attr) {
  var snap = await getDoc(doc(db, all_tokens.uid, 'devices', 'devices', device));
  var data = snap.data();
  return data ? data[attr] : undefined;
};

// Realtime Database: current reading values
async function setReading(device, reading, value) {
  await set(ref(realdb, 'users/' + all_tokens.uid + '/readings/' + escapeKey(device) + '/' + escapeKey(reading)), {
    value: value,
    devname: device
  });
}

async function hasReadings() {
  var snap = await get(ref(realdb, 'users/' + all_tokens.uid + '/readings'));
  var val = snap.val();
  return !!val && Object.keys(val).length > 0;
}

// delete all documents of a firestore collection in chunks
async function deleteCollection(collRef) {
  for (; ;) {
    var snap = await getDocs(query(collRef, limit(BATCH_SIZE)));
    if (snap.empty)
      return;
    var batch = writeBatch(db);
    snap.docs.forEach(function (d) {
      batch.delete(d.ref);
    });
    await batch.commit();
  }
}

// delete devices/readings in realtime database and devices/attributes in firestore
async function clearUserData() {
  try {
    await remove(ref(realdb, 'users/' + all_tokens.uid + '/devices'));
    await remove(ref(realdb, 'users/' + all_tokens.uid + '/readings'));
  } catch (err) {
    log.error('Realtime Database deletion failed: ' + err);
  }

  try {
    await deleteCollection(collection(db, all_tokens.uid, 'devices', 'devices'));
  } catch (err) {
    log.error('Device deletion failed: ' + err);
  }

  try {
    await deleteCollection(collection(db, all_tokens.uid, 'devices', 'attributes'));
  } catch (err) {
    log.error('Attribute deletion failed: ' + err);
  }
}

function firestore2fhemCollection() {
  return collection(db, all_tokens.uid, 'msgs', 'firestore2fhem');
}

async function deleteFirestore2FhemMessages() {
  await deleteCollection(firestore2fhemCollection());
}

// callback(data) is called once for every new message, messages are deleted afterwards
function onFirestore2FhemMessage(callback) {
  return onSnapshot(firestore2fhemCollection(), function (snapshot) {
    snapshot.docChanges().forEach(function (change) {
      if (change.type !== 'added')
        return;
      try {
        callback(change.doc.data());
      } catch (err) {
        log.error('onSnapshot event failed: ' + err);
      }
      deleteDoc(change.doc.ref).catch(function (err) {
        log.error('Failed to delete firestore2fhem message: ' + err);
      });
    });
  }, function (err) {
    log.error('onSnapshot failed: ' + err);
  });
}

//create verifier
function base64URLEncode(str) {
  return str.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

//create challenge
function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest();
}

function getUrl() {
  verifier = base64URLEncode(crypto.randomBytes(32));
  var challenge = base64URLEncode(sha256(verifier));

  return AUTH0_DOMAIN + "/authorize?audience=" + AUDIENCE_URI + "&scope=offline_access%20openid%20profile&response_type=code&client_id=" + CLIENT_ID + "&code_challenge=" + challenge + "&code_challenge_method=S256&redirect_uri=" + CODE_REDIRECT_URI;
}

async function postAuth0Token(body) {
  const response = await fetch(AUTH0_DOMAIN + '/oauth/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  return await response.json();
}

async function handleAuthCode(auth_code) {
  //send POST to request a token
  //TODO set state and verify state on codelanding page
  var tokens = await postAuth0Token({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code_verifier: verifier,
    code: auth_code,
    redirect_uri: CODE_REDIRECT_URI
  });
  all_tokens.access = tokens.access_token;
  all_tokens.id = tokens.id_token;
  all_tokens.refresh = tokens.refresh_token;

  if (!all_tokens.refresh)
    throw new Error('No refresh token available, please login again');

  _fhem.execute('set ' + _fhem.gassistant + ' refreshToken ' + all_tokens.refresh);
  //TODO set reading email from id token

  var firebase_token = await createFirebaseCustomToken(all_tokens.access);
  all_tokens.firebase = firebase_token.firebase;
  all_tokens.uid = firebase_token.uid;

  _fhem.execute('setreading ' + _fhem.gassistant + ' gassistant-fhem-uid ' + all_tokens.uid);

  await signInWithCustomToken(fbAuth, all_tokens.firebase);
  scheduleTokenRefresh(tokens.expires_in);
}

function setFhemDeviceInstance(fhem) {
  _fhem = fhem;
  _fhem.execute('setreading ' + _fhem.gassistant + ' gassistant-fhem-version ' + versionnr);
}

function setRefreshToken(refreshToken) {
  all_tokens.refresh = refreshToken;
}

async function refreshToken(refresh_token) {
  //send POST to request a token
  var tokens = await postAuth0Token({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: refresh_token
  });
  if (tokens.error) {
    throw new Error('Invalid refresh token');
  }

  return {
    access: tokens.access_token,
    id: tokens.id_token,
    refresh: tokens.refresh_token,
    expires_in: tokens.expires_in
  };
}

async function createFirebaseCustomToken(access_token) {
  var response = await fetch(FB_CUSTOM_TOKEN_URI, {
    headers: {
      'Authorization': 'Bearer ' + access_token,
      'content-type': 'application/json'
    }
  });

  if (response.status != 200)
    throw new Error('Failed to get Firebase token: ' + response.status + ' ' + await response.text());

  //{firebase_token: token, uid: uid}
  var token = await response.json();
  return {
    uid: token.uid,
    firebase: token.firebase_token
  }
}

module.exports = {
  setMappings: setMappings,
  getMappings: getMappings,
  getUid: getUid,
  escapeKey: escapeKey,
  deleteUserAccount: deleteUserAccount,
  getConfiguration: getConfiguration,
  getClientFunctions: getClientFunctions,
  gethandleEXECUTE: gethandleEXECUTE,
  gethandleQUERY: gethandleQUERY,
  getServerFeatureLevel: getServerFeatureLevel,
  getSyncFeatureLevel: getSyncFeatureLevel,
  reportState: reportState,
  reportStateWithData: reportStateWithData,
  reportStateAll: reportStateAll,
  initiateSync: initiateSync,
  generateMappings: generateMappings,
  clientHeartbeat: clientHeartbeat,
  clientShutdown: clientShutdown,
  reportClientVersion: reportClientVersion,
  sendToFirestore: sendToFirestore,
  setDeviceAttribute: setDeviceAttribute,
  getDeviceAttribute: getDeviceAttribute,
  setReading: setReading,
  hasReadings: hasReadings,
  clearUserData: clearUserData,
  deleteFirestore2FhemMessages: deleteFirestore2FhemMessages,
  onFirestore2FhemMessage: onFirestore2FhemMessage,
  getUrl: getUrl,
  handleAuthCode: handleAuthCode,
  setFhemDeviceInstance: setFhemDeviceInstance,
  setRefreshToken: setRefreshToken,
  refreshAllTokens: refreshAllTokens,
  initFirebase: initFirebase
};
