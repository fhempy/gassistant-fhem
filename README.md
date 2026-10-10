# Google Assistant FHEM Connect
Connect FHEM to the FHEM Connect addon in your Google Home app.

See https://wiki.fhem.de/wiki/Google_Assistant_FHEM_Connect

## Requirements

- Node.js 20 or newer
- FHEM with a `gassistant` device (`define gassistant gassistant`)

## Installation

With the current `39_gassistant.pm` of FHEM (`update` in FHEM) nothing has to be installed manually:
`define gassistant gassistant` installs gassistant-fhem with an own Node.js 22 in
`~/.fhemconnect/runtime` of the FHEM user (needs `curl` or `wget`, no root rights, independent of the
Node.js version of the system). Existing global installations are switched automatically: the global
installation is used until the local installation is finished, then gassistant-fhem is restarted.
The installation runs with low CPU and IO priority, on a Raspberry Pi it takes a few minutes. The
progress is shown in the reading `gassistant-fhem-install`, details in
`~/.fhemconnect/runtime/install.log`.

Global installation (`attr gassistant gassistantFHEM-runtime system`, older `39_gassistant.pm`):

```
sudo npm install -g gassistant-fhem
```

## Usage

```
gassistant-fhem [options]

  -D, --debug          turn on debug level logging
  -c, --config <path>  location of the config file (default: ~/.fhemconnect/gassistant-fhem.cfg)
  -a, --auth <auth>    user:password for FHEM connection
  -s, --ssl            use https for FHEM connection
```

The config file is created with default values on first start:

```json
{
  "connections": [{
    "name": "FHEM",
    "server": "127.0.0.1",
    "port": "8083",
    "webname": "fhem",
    "filter": "room=GoogleAssistant",
    "auth": { "user": "fhemuser", "pass": "secret" },
    "ssl": false
  }]
}
```

`auth` and `ssl` are optional.

## Update

From FHEM (the version is optional, default is the latest version):

```
set gassistant update [version]
```

With the local installation (default of the current `39_gassistant.pm`) the module installs the
version and restarts gassistant-fhem, Node.js is updated to the latest 22.x as well. The progress is
shown in the reading `gassistant-fhem-install`.

With a global installation gassistant-fhem installs the new version with the npm of the Node.js
installation it is running on (also nvm installations) and is restarted by FHEM afterwards. The
progress is shown in the reading `gassistant-fhem-update`. The global npm directory must be writable
for the FHEM user, otherwise update manually as root: `npm install -g gassistant-fhem`.
With a `39_gassistant.pm` which doesn't know `set ... update` yet:

```
trigger gassistant update: latest
```

## FHEM module

The FHEM module `39_gassistant.pm` is maintained in FHEM SVN and installed with `update` in FHEM.
The current version supports:

- local installation of gassistant-fhem and Node.js (`gassistantFHEM-runtime`)
- `set gassistant update [version]`
- `gassistantFHEM-log`: custom log file names work (#14)

## Development

```
npm install
npm test
```

## Changelog

### 4.1.3
- Network errors during the login at startup (e.g. Firebase `auth/network-request-failed`, Auth0
  `server_error`) are retried (10 s, 20 s, ... up to 5 minutes). Before, gassistant-fhem stayed
  disconnected with `login failed, please retry` until it was restarted manually. An invalid refresh
  token still requires a new login.

### 4.1.2
- Google SYNC only if the devices changed (name, room, mappings, ...) since the last SYNC. A restart
  or reconnect with unchanged devices doesn't request a SYNC any more, a room change requests one
  SYNC instead of two. `set gassistant reload` still always requests a SYNC.

### 4.1.1
- FHEM events are processed faster: changed readings are written to the Realtime Database without
  waiting for the confirmation (~100-150 ms per reading). Report state reaches Google earlier when
  many readings change at once.

### 4.1.0
- Update from FHEM: `set gassistant update [version]` or `trigger gassistant update: latest`.

### 4.0.3
- Fewer Report State calls (lower Cloud Function costs): unchanged states are not reported again,
  changes within one second are sent together in one request.

### 4.0.2
- Fixed: `not a number: undefined => NaN` errors in the log when a mapped reading doesn't exist
  (e.g. `color` of zigbee2mqtt lights).

### 4.0.1
- Fixed: Local Home (`gassistant-fhem-localHome`) stayed inactive:
  - requests with many devices were rejected (100 kB limit)
  - the mDNS SRV target was not a valid `.local` host name
  - the reading fell back to `inactive` after 5 minutes
- REACHABLE_DEVICES works without the deprecated `devices` field of the request.
- New reading `gassistant-fhem-localHomeDevices` with the number of devices reachable locally,
  every Local Home request is logged.

### 4.0.0
- The client code is part of the npm package now. Before, it was downloaded from
  Firebase Hosting on every start and executed with vm2 (which has known sandbox escapes).
- Requires Node.js 20 or newer.
- Dependencies updated: firebase 12 (modular API), express 5, commander 14,
  bonjour-service instead of bonjour. request, request-promise, node-fetch, sync-request,
  vm2, grpc, api-npm, ps-node and readline-sync were removed.
- Fixed: Local Home did not fall back to another port if 37000 was in use.
- Fixed: Unregister always failed because the access token was deleted before the request.
- Fixed: FHEM readings were not set to `disconnected` on shutdown.
- Fixed: Client crashed on network errors during token refresh, report state or heartbeat.
- Fixed: Passwords from the connection config were written to the log.
- Fixed: Basic auth from one connection was used for other connections without auth.
- Fixed: Passwords containing `:` were cut off for `--auth`.
- Fixed: Detection of an already running instance did not work.
- Fixed: Firestore batch limit was exceeded when deleting more than 500 devices.
- Fixed: Default config could not be written if `~/.fhemconnect` did not exist.
