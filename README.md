# Google Assistant FHEM Connect
Connect FHEM to the FHEM Connect addon in your Google Home app.

See https://wiki.fhem.de/wiki/Google_Assistant_FHEM_Connect

## Requirements

- Node.js 20 or newer
- FHEM with a `gassistant` device (`define gassistant gassistant`)

## Installation

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

With a `39_gassistant.pm` which doesn't know `set ... update` yet (see `fhem/39_gassistant.pm-update.patch`):

```
trigger gassistant update: latest
```

gassistant-fhem installs the new version with the npm of the Node.js installation it is running on
(also nvm installations) and is restarted by FHEM afterwards. The progress is shown in the reading
`gassistant-fhem-update`. The global npm directory must be writable for the FHEM user, otherwise
update manually as root: `npm install -g gassistant-fhem`.

## Development

```
npm install
npm test
```

## Changelog

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
