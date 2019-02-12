const crypto = require('crypto');
const fetch = require('node-fetch');
const firebase = require('firebase/app');
require('firebase/auth');
require('firebase/firestore');
require('firebase/database');
const fs = require('fs');
const settings = require('./settings.json');
const versionnr = require('./version');
const npmapi = require('api-npm');

const CLOUD_FUNCTIONS_BASE = settings.CLOUD_FUNCTIONS_BASE;
const AUDIENCE_URI = settings.AUDIENCE_URI;
const CLIENT_ID = settings.CLIENT_ID;
const AUTH0_DOMAIN = settings.AUTH0_DOMAIN;

var fbApp = firebase.initializeApp(settings.firebase);

var db = firebase.firestore();

var all_tokens = {};
var heartbeat;
var realdb = firebase.database();
var _fhem;

exports.db = db;
exports.realdb = realdb;
exports.getUid = function() {
  return all_tokens.uid;
};

var verifier;

const CODE_REDIRECT_URI = CLOUD_FUNCTIONS_BASE + "/codelanding/start";
const FB_CUSTOM_TOKEN_URI = CLOUD_FUNCTIONS_BASE + "/firebase/token";
const REPORT_STATE_ALL = CLOUD_FUNCTIONS_BASE + "/api/reportstateall";
const SYNC_FINISHED = CLOUD_FUNCTIONS_BASE + "/api/syncfinished";
const UPDATE_INFORMID = CLOUD_FUNCTIONS_BASE + "/api/updateinformid";
const INIT_SYNC = CLOUD_FUNCTIONS_BASE + "/api/initsync";
const DELETE_USER_ACCOUNT = CLOUD_FUNCTIONS_BASE + "/api/deleteuseraccount";
const GET_SERVER_FEATURELEVEL = CLOUD_FUNCTIONS_BASE + "/api/getfeaturelevel";
const GET_SYNC_FEATURELEVEL = CLOUD_FUNCTIONS_BASE + "/api/getsyncfeaturelevel";


exports.refreshAllTokens = async function refreshAllTokens() {
  if (!all_tokens.refresh) {
    console.error('No refresh token found.');
    console.error('Delete the token file and start the process again');
    process.exit(1);
  }

  npmapi.getdetails('gassistant-fhem', function(data) {
    try {
      if (_fhem) {
        _fhem.execute('setreading ' + _fhem.gassistant + ' gassistant-fhem-versionAvailable ' + data['dist-tags'].latest);
      }
    } catch(err) {
      console.error('Failed to check latest version on npmjs: ' + err);
    }
  });

  auth0_tokens = await refreshToken(all_tokens.refresh);
  firebase_token = await createFirebaseCustomToken(auth0_tokens.access);
  var signin = await firebase.auth().signInWithCustomToken(firebase_token.firebase);
  
  console.log('Refresh tokens finished. Next refresh in ' + auth0_tokens.expires_in + ' seconds.');
  setTimeout(refreshAllTokens, (auth0_tokens.expires_in-120)*1000);

  all_tokens = {access: auth0_tokens.access, id: auth0_tokens.id, refresh: all_tokens.refresh, firebase: firebase_token.firebase, uid: firebase_token.uid};
  return;
}

exports.deleteUserAccount = async function deleteUserAccount() {
  var res = await fetch(DELETE_USER_ACCOUNT, {
    headers: {
      'Authorization': 'Bearer ' + all_tokens.access,
      'content-type': 'application/json'
    }
  });
  
  if (res.status == 401) {
    await refreshAllTokens();
    await fetch(DELETE_USER_ACCOUNT, {
      headers: {
        'Authorization': 'Bearer ' + all_tokens.access,
        'content-type': 'application/json'
      }
    });
  }
  
  all_tokens = {};
}

exports.getServerFeatureLevel = async function getServerFeatureLevel() {
  var res = await fetch(GET_SERVER_FEATURELEVEL, {
    headers: {
      'Authorization': 'Bearer ' + all_tokens.access,
      'content-type': 'application/json'
    }
  });
  
  if (res.status == 401) {
    await refreshAllTokens();
    res = await fetch(GET_SERVER_FEATURELEVEL, {
      headers: {
        'Authorization': 'Bearer ' + all_tokens.access,
        'content-type': 'application/json'
      }
    });
  }
  
  var json = await res.json();
  
  return json;
}

exports.getSyncFeatureLevel = async function getSyncFeatureLevel() {
  var res = await fetch(GET_SYNC_FEATURELEVEL, {
    headers: {
      'Authorization': 'Bearer ' + all_tokens.access,
      'content-type': 'application/json'
    }
  });
  
  if (res.status == 401) {
    await refreshAllTokens();
    res = await fetch(GET_SYNC_FEATURELEVEL, {
      headers: {
        'Authorization': 'Bearer ' + all_tokens.access,
        'content-type': 'application/json'
      }
    });
  }
  
  var json = await res.json();
  
  return json;
}

exports.clientHeartbeat = async function clientHeartbeat() {
  await realdb.ref('users/' + all_tokens.uid + '/heartbeat').set({active: 1, time: Date.now()});
  heartbeat = setTimeout(clientHeartbeat, 5000);
  return;
}

exports.clientShutdown = async function () {
  if (_fhem) {
    await _fhem.execute_await('setreading ' + _fhem.gassistant + ' gassistant-fhem-connection disconnected');
    await _fhem.execute_await('deletereading ' + _fhem.gassistant + ' gassistantFHEM.loginURL');
  }
  clearTimeout(heartbeat);
  realdb.ref('users/' + all_tokens.uid + '/heartbeat').set({active: 0, time: Date.now()});
  return;
}

exports.requestReportStateAll = async function() {
  var res = await fetch(REPORT_STATE_ALL, {
    headers: {
      'Authorization': 'Bearer ' + all_tokens.access,
      'content-type': 'application/json'
    }
  });
  
  if (res.status == 401) {
    await refreshAllTokens();
    await fetch(REPORT_STATE_ALL, {
      headers: {
        'Authorization': 'Bearer ' + all_tokens.access,
        'content-type': 'application/json'
      }
    });
  }
};

exports.updateInformId = async function(informId, device, val) {
  //realdb.ref('users/' + all_tokens.uid + '/informids/' + informId + '/').set({value: val, device: device});
  var res = await fetch(UPDATE_INFORMID, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + all_tokens.access,
      'content-type': 'application/json'
    },
    body: JSON.stringify({informId: informId, value: val, device: device})
  });
  
  if (res.status == 401) {
    await refreshAllTokens();
    await fetch(UPDATE_INFORMID, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + all_tokens.access,
        'content-type': 'application/json'
      },
      body: JSON.stringify({informId: informId, value: val, device: device})
    });
  }
};

exports.initiateSync = async function() {
  var res = await fetch(INIT_SYNC, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + all_tokens.access,
      'content-type': 'application/json'
    }
  });
  
  if (res.status == 401) {
    await refreshAllTokens();
    await fetch(INIT_SYNC, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + all_tokens.access,
        'content-type': 'application/json'
      }
    });
  }
  console.log('SYNC initiated');
}

exports.syncFinished = async function() {
  var res = await fetch(SYNC_FINISHED, {
    headers: {
      'Authorization': 'Bearer ' + all_tokens.access,
      'content-type': 'application/json'
    }
  });

  if (res.status == 401) {
    await refreshAllTokens();
    await fetch(SYNC_FINISHED, {
      headers: {
        'Authorization': 'Bearer ' + all_tokens.access,
        'content-type': 'application/json'
      }
    });
  }
};

exports.reportClientVersion = async function() {
  await db.collection(all_tokens.uid).doc('client').set({version: settings.CLIENT_VERSION, packageversion: versionnr}, {merge: true});
}

exports.sendToFirestore = async function(msg, id) {
  await db.collection(all_tokens.uid).doc('msgs').collection('fhem2firestore').add({msg: msg, id: id});
}

exports.setDeviceAttribute = function(device, attr, val) {
  db.collection(all_tokens.uid).doc('devices').collection('devices').doc(device).set({[attr]: val}, {merge: true});
};

exports.getDeviceAttribute = async function(device, attr) {
  var doc = await db.collection(all_tokens.uid).doc('devices').collection('devices').doc(device).get();
  return doc.data()[attr];
};

function readTokenFile() {
  try {
    //read uid, access_token, firebase_token from file
    var tokens = fs.readFileSync('token', 'utf-8');
    tokens = JSON.parse(tokens);
    return {uid: tokens.uid, access: tokens.access, refresh: tokens.refresh, firebase: tokens.firebase};
  } catch (err) {
    console.log('Token file not found, starting login procedure...');
    return undefined;
  }
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

exports.getUrl = function getUrl() {
  verifier = base64URLEncode(crypto.randomBytes(32));
  var challenge = base64URLEncode(sha256(verifier));
  
  return AUTH0_DOMAIN + "/authorize?audience=" + AUDIENCE_URI + "&scope=offline_access%20openid%20profile&response_type=code&client_id=" + CLIENT_ID + "&code_challenge=" + challenge + "&code_challenge_method=S256&redirect_uri=" + CODE_REDIRECT_URI;
}

exports.handleAuthCode = async function handleAuthCode(auth_code) {
  //send POST to request a token
  //TODO set state and verify state on codelanding page
  var options = { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"grant_type":"authorization_code","client_id":"' + CLIENT_ID + '","code_verifier":"' + verifier + '","code": "' + auth_code + '","redirect_uri": "' + CODE_REDIRECT_URI + '"}' };
  const response = await fetch(AUTH0_DOMAIN + '/oauth/token', options);
  var tokens = await response.json();
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
  
  var signinFb = await firebase.auth().signInWithCustomToken(all_tokens.firebase);
}

exports.setFhemDeviceInstance = function(fhem) {
  _fhem = fhem;
  _fhem.execute('setreading ' + _fhem.gassistant + ' gassistant-fhem-version ' + versionnr);
}

async function initiateAuth0Login() {
    verifier = base64URLEncode(crypto.randomBytes(32));
    var challenge = base64URLEncode(sha256(verifier));
  
    console.log(' ');
    console.log('Please open the following link in your browser:');
    console.log(AUTH0_DOMAIN + "/authorize?audience=" + AUDIENCE_URI + "&scope=openid%20profile%20offline_access&response_type=code&client_id=" + CLIENT_ID + "&code_challenge=" + challenge + "&code_challenge_method=S256&redirect_uri=" + CODE_REDIRECT_URI);
    console.log(' ');
    
    //request code from user
    const readline = require('readline-sync');
  
    var auth_code = readline.question('Please enter the authorization code here: ');
  
    //send POST to request a token
    //TODO set state and verify state on codelanding page
    var options = { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"grant_type":"authorization_code","client_id":"' + CLIENT_ID + '","code_verifier":"' + verifier + '","code": "' + auth_code + '","redirect_uri": "' + CODE_REDIRECT_URI + '"}' };
    const response = await fetch(AUTH0_DOMAIN + '/oauth/token', options);
    var tokens = await response.json();
    return {access: tokens.access_token, id: tokens.id_token, refresh: tokens.refresh_token};
}

exports.setRefreshToken = function(refreshToken) {
  all_tokens.refresh = refreshToken;
}

async function refreshToken(refresh_token) {
  //send POST to request a token
  var options = { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"grant_type":"refresh_token","client_id":"' + CLIENT_ID + '","refresh_token":"' + refresh_token + '"}' };

  const response = await fetch(AUTH0_DOMAIN + '/oauth/token', options);
  var tokens = await response.json();
  if (tokens.error) {
    throw new Error('Invalid refresh token');
  }
  var exp_seconds = tokens.expires_in;
  var access_token = tokens.access_token;
  var id_token = tokens.id_token;
  var refresh_token = tokens.refresh_token;
  
  return {access: access_token, id: id_token, refresh: refresh_token, expires_in: exp_seconds};
}

async function createFirebaseCustomToken(access_token) {
  //console.log('access_token: ' + access_token);
  var response = await fetch(FB_CUSTOM_TOKEN_URI, {
    headers: {
      'Authorization': 'Bearer ' + access_token,
      'content-type': 'application/json'
    }
  });
  
  if (response.status == 401) {
    await refreshAllTokens();
    response = await fetch(FB_CUSTOM_TOKEN_URI, {
      headers: {
        'Authorization': 'Bearer ' + access_token,
        'content-type': 'application/json'
      }
    });
  }
  
  //{firebase_token: token, uid: uid}
  var token = await response.json();
  //console.log('fb: ' + JSON.stringify(token));
  return {uid: token.uid, firebase: token.firebase_token}
}
