var database = require('./database');

const uidlog = require('./logger').nouidlog;
const uiderror = require('./logger').uiderror;


function initSync(uid) {
  return undefined;
}

function prepareDevice(uid, dev) {
  if (!dev || !dev.mappings) {
    throw new Error('No mappings identified for ' + dev.name);
  }
  for (characteristic_type in dev.mappings) {
    let mappingChar = dev.mappings[characteristic_type];
    //mappingChar = Modes array

    if (!Array.isArray(mappingChar))
      mappingChar = [mappingChar];

    let mappingRoot;
    for (mappingRoot in mappingChar) {
      mappingRoot = mappingChar[mappingRoot];
      //mappingRoot = first element of Modes array
      if (!Array.isArray(mappingRoot))
        mappingRoot = [mappingRoot];

      for (mappingElement in mappingRoot) {
        mapping = mappingRoot[mappingElement];

        if (mapping.reading2homekit) {
          eval('mapping.reading2homekit = ' + mapping.reading2homekit);
        }
        if (mapping.homekit2reading) {
          eval('mapping.homekit2reading = ' + mapping.homekit2reading);
        }
        if (mapping.cmdFunction) {
          eval('mapping.cmdFunction = ' + mapping.cmdFunction);
        }
      }
    }
  }
}

function getAllDevicesAndReadings(uid) {
  var devices = {};
  var readings = require('./fhem').getCurrentReadings();

  var allDevices = database.getMappings();
  Object.keys(allDevices).forEach(function (device) {
    var a = {
      'device': allDevices[device]['XXXDEVICEDEFXXX'],
      'readings': readings[allDevices[device]['XXXDEVICEDEFXXX'].name]
    };
    prepareDevice(uid, a['device']);
    devices[allDevices[device]['XXXDEVICEDEFXXX'].name] = a;
  });
  return devices;
}

function sendCmd2Fhem(uid, fcmds) {
  for (var c in fcmds) {
    require('./fhem').FHEM_execute({
      base_url: c
    }, fcmds[c]);
  }
}

function createDirective(reqId, payload) {
  return {
    requestId: reqId,
    payload: payload
  };
} // createDirective

function getClientVersion(uid) {
  //FIXME retrieve client version from settings.json
  return "2.3.0";
}

function getDeviceAndReadings(uid, devicename) {
  var devices = getAllDevicesAndReadings(uid);
  return devices[devicename];
}

function FHEM_reading2homekit_(uid, mapping, readings) {
  var value = readings[mapping.reading[0].replace(/\.|\#|\[|\]|\$/g, '_')];
  if (mapping.selectReading && readings[mapping.characteristic_type + '-' + mapping.selectReading]) {
    var selReading = readings[mapping.characteristic_type + '-' + mapping.selectReading];
    if (readings[selReading])
      value = readings[selReading];
  }
  if (value === undefined)
    return undefined;

  var reading = mapping.reading.toString();

  if (reading == 'temperature' ||
    reading == 'measured' ||
    reading == 'measured-temp' ||
    reading == 'desired-temp' ||
    reading == 'desired' ||
    reading == 'desiredTemperature') {
    if (value == 'on')
      value = 31.0;
    else if (value == 'off')
      value = 4.0;
    else {
      value = parseFloat(value);
    }

    if (mapping.minValue !== undefined && value < mapping.minValue)
      value = mapping.minValue;
    else if (mapping.maxValue !== undefined && value > mapping.maxValue)
      value = mapping.maxValue;

    if (mapping.minStep) {
      if (mapping.minValue)
        value -= mapping.minValue;
      value = parseFloat((Math.round(value / mapping.minStep) * mapping.minStep).toFixed(1));
      if (mapping.minValue)
        value += mapping.minValue;
    }

  } else if (reading == 'humidity') {
    value = parseInt(value);

  } else if (reading == 'onoff') {
    value = parseInt(value) ? true : false;

  } else if (reading === 'state' && (mapping.On &&
    typeof mapping.values !== 'object' &&
    mapping.reading2homekit === undefined &&
    mapping.valueOn === undefined && mapping.valueOff === undefined)) {
    if (value.match(/^set-/))
      return undefined;
    if (value.match(/^set_/))
      return undefined;

    if (mapping.event_map !== undefined) {
      var mapped = mapping.event_map[value];
      if (mapped !== undefined)
        value = mapped;
    }

    if (value == 'off')
      value = 0;
    else if (value == '000000')
      value = 0;
    else if (value.match(/^[A-D]0$/))
      value = 0;
    else
      value = 1;

  } else {
    if (value.match(/^set-/))
      return undefined;
    else if (value.match(/^set_/))
      return undefined;

    if (isNaN(value) === false) {
      value = parseFloat(value);
    }

    var orig = value;

    var format = undefined;
    if (typeof mapping.characteristic === 'object')
      format = mapping.characteristic.props.format;
    else if (typeof mapping.characteristic === 'function') {
      var characteristic = new (Function.prototype.bind.apply(mapping.characteristic, arguments));

      format = characteristic.props.format;

      //delete characteristic;
    } else if (mapping.format) { // only for testing !
      format = mapping.format;

    }

    if (mapping.event_map !== undefined) {
      var mapped = mapping.event_map[value];
      if (mapped !== undefined) {
        uidlog(uid, mapping.reading.toString() + ' eventMap: value ' + value + ' mapped to: ' + mapped);
        value = mapped;
      }
    }

    if (value !== undefined && mapping.part !== undefined) {
      var mapped = value.split(' ')[mapping.part];

      if (mapped === undefined) {
        uiderror(uid, mapping.reading.toString() + ' value ' + value + ' has no part ' + mapping.part);
        return value;
      }
      uidlog(uid, mapping.reading.toString() + ' parts: using part ' + mapping.part + ' of: ' + value + ' results in: ' + mapped);
      value = mapped;
    }

    if (mapping.threshold) {
      //if( !format.match( /bool/i ) && mapping.threshold ) {
      var mapped;
      if (parseFloat(value) > mapping.threshold)
        mapped = 1;
      else
        mapped = 0;
      uidlog(uid, mapping.reading.toString() + ' threshold: value ' + value + ' mapped to ' + mapped);
      value = mapped;
    }

    if (mapping.valueError) {
      if (value.toString().match(mapping.valueError)) {
        return "ERROR";
      }
    }

    if (mapping.valueException) {
      if (value.toString().match(mapping.valueException)) {
        return "EXCEPTION";
      }
    }

    if (typeof mapping.value2homekit_re === 'object' || typeof mapping.value2homekit === 'object') {
      var mapped = undefined;
      if (typeof mapping.value2homekit_re === 'object')
        for (var entry of mapping.value2homekit_re) {
          if (entry.reading) {
            value = readings[entry.reading];
            if (!value)
              uiderror(uid, 'reading ' + entry.reading + ' not found in reading array: ' + JSON.stringify(readings));
          }
          if (value.toString().match(entry.re)) {
            mapped = entry.to;
            break;
          }
        }

      if (mapped === '#')
        mapped = value;

      if (typeof mapping.value2homekit === 'object')
        if (mapping.value2homekit[value] !== undefined)
          mapped = mapping.value2homekit[value];

      if (mapped === undefined)
        mapped = mapping.default;

      if (mapped === undefined) {
        uiderror(uid, mapping.reading.toString() + ' value ' + value + ' not handled in values');
        return undefined;
      }

      if (mapped == 'true' || mapped == 'false') {
        mapped = (mapped == 'true');
      }

      uidlog(uid, mapping.reading.toString() + ' values: value ' + value + ' mapped to ' + mapped);
      value = mapped;
    }

    if (!format) {
      uidlog(uid, mapping.reading.toString() + ' empty format, value: ' + value);
    } else if (format.match(/bool/i)) {
      var mapped = undefined;;
      if (mapping.valueOn !== undefined) {
        var match = mapping.valueOn.match('^/(.*)/$');
        if (!match && value == mapping.valueOn)
          mapped = 1;
        else if (match && value.toString().match(match[1]))
          mapped = 1;
        else
          mapped = 0;
      }
      if (mapping.valueOff !== undefined) {
        var match = mapping.valueOff.match('^/(.*)/$');
        if (!match && value == mapping.valueOff)
          mapped = 0;
        else if (match && value.toString().match(match[1]))
          mapped = 0;
        else if (mapped === undefined)
          mapped = 1;
      }
      if (mapping.valueOn === undefined && mapping.valueOff === undefined) {
        if (value == 'on')
          mapped = 1;
        else if (value == 'off')
          mapped = 0;
        else
          mapped = parseInt(value) ? 1 : 0;
      }
      if (mapped !== undefined) {
        uidlog(uid, mapping.reading.toString() + ' valueOn/valueOff: value ' + value + ' mapped to ' + mapped);
        value = mapped;
      }

      if (mapping.factor) {
        uidlog(uid, mapping.reading.toString() + ' factor: value ' + value + ' mapped to ' + value * mapping.factor);
        value *= mapping.factor;
      }

      if (mapping.invert) {
        mapping.minValue = 0;
        mapping.maxValue = 1;
      }

    } else if (format.match(/float/i)) {
      var mapped = parseFloat(value);

      if (typeof mapped !== 'number') {
        uiderror(uid, mapping.reading.toString() + ' is not a number: ' + value);
        return undefined;
      }
      value = mapped;

      if (mapping.factor) {
        uidlog(uid, mapping.reading.toString() + ' factor: value ' + value + ' mapped to ' + value * mapping.factor);
        value *= mapping.factor;
      }

    } else if (format.match(/int/i)) {
      var mapped = parseFloat(value);

      if (typeof mapped !== 'number') {
        uiderror(uid, mapping.reading.toString() + ' not a number: ' + value);
        return undefined;
      }
      value = mapped;

      if (mapping.factor) {
        uidlog(uid, mapping.reading.toString() + ' factor: value ' + value + ' mapped to ' + value * mapping.factor);
        value *= mapping.factor;
      }

      value = parseInt(value + 0.5);
    } else if (format.match(/string/i)) { }


    if (mapping.max && mapping.maxValue) {
      value = Math.round((value * mapping.maxValue / mapping.max) * 100) / 100;
      uidlog(uid, mapping.reading.toString() + ' value ' + orig + ' scaled to: ' + value);
    }

    if (mapping.minValue !== undefined && value < mapping.minValue) {
      uidlog(uid, mapping.reading.toString() + ' value ' + value + ' clipped to minValue: ' + mapping.minValue);
      value = mapping.minValue;
    } else if (mapping.maxValue !== undefined && value > mapping.maxValue) {
      uidlog(uid, mapping.reading.toString() + ' value ' + value + ' clipped to maxValue: ' + mapping.maxValue);
      value = mapping.maxValue;
    }

    if (mapping.minStep) {
      if (mapping.minValue)
        value -= mapping.minValue;
      value = parseFloat((Math.round(value / mapping.minStep) * mapping.minStep).toFixed(1));
      if (mapping.minValue)
        value += mapping.minValue;
    }

    if (format && format.match(/int/i))
      value = parseInt(value);
    else if (format && format.match(/float/i))
      value = parseFloat(value);

    if (typeof value === 'number') {
      var mapped = value;
      if (isNaN(value)) {
        uiderror(uid, mapping.reading.toString() + ' not a number: ' + orig);
        return undefined;
      } else if (mapping.invert && mapping.minValue !== undefined && mapping.maxValue !== undefined) {
        mapped = mapping.maxValue - value + mapping.minValue;
      } else if (mapping.invert && mapping.maxValue !== undefined) {
        mapped = mapping.maxValue - value;
      } else if (mapping.invert) {
        mapped = 100 - value;
      }

      if (value !== mapped)
        uidlog(uid, mapping.reading.toString() + ' value: ' + value + ' inverted to ' + mapped);
      value = mapped;
    }
    if (format && format.match(/bool/i)) {
      value = parseInt(value) ? true : false;
    }
  }

  return value;
}

async function checkExceptions(uid, device, readings, response) {
  for (var exception_name in device.mappings.Exceptions) {
    //FIXME support exceptions for multiple responses
    if (device.mappings.Exceptions[exception_name].onlyLinkedInfo === false) {
      if (await cached2Format(uid, device.mappings.Exceptions[exception_name], readings) === "EXCEPTION") {
        response[0].states.exceptionCode = exception_name;
      }
    }
  }
}

async function checkLinkedDevices(uid, device) {
  var currentStatusReport = [];
  var isBlocking = false;
  if (device.mappings.LinkedDevices) {
    for (var ld of device.mappings.LinkedDevices.devices) {
      //devicename: ld.id
      //blocking: ld.blocking
      var linkedDevice = await getDeviceAndReadings(uid, ld.id);
      //check for exceptions in linkedDevice
      if (linkedDevice.device.mappings.Exceptions) {
        for (var exception_name in linkedDevice.device.mappings.Exceptions) {
          if (await cached2Format(uid, linkedDevice.device.mappings.Exceptions[exception_name], linkedDevice.readings) === "EXCEPTION") {
            if (ld.blocking)
              isBlocking = true;
            currentStatusReport.push({
              blocking: ld.blocking ? ld.blocking : false,
              deviceTarget: ld.id,
              priority: 0,
              statusCode: exception_name
            });
          }
        }
      }
    }
  }
  return {
    report: currentStatusReport,
    blocking: isBlocking
  };
}

function FHEM_reading2homekit(uid, mapping, readings) {
  if (mapping.fixedValue)
    return mapping.fixedValue;

  var value = undefined;
  //BACKWARD COMPATIBILITY
  if (typeof mapping.reading === 'string') {
    uidlog(uid, 'OLDFUNCTION FHEM_reading2homekit - SYNC needed');
    mapping.reading = [mapping.reading];
  }
  var orig = readings[mapping.reading[0].replace(/\.|\#|\[|\]|\$/g, '_')];
  if (mapping.reading2homekit && typeof mapping.reading2homekit == 'function') {
    uidlog(uid, 'function found for reading2homekit');
    try {
      if (mapping.reading.length === 1) {
        orig = readings[mapping.reading[0].replace(/\.|\#|\[|\]|\$/g, '_')];
        value = mapping.reading2homekit(mapping, readings[mapping.reading[0].replace(/\.|\#|\[|\]|\$/g, '_')]);
      } else
        value = mapping.reading2homekit(mapping, readings);
    } catch (err) {
      uiderror(uid, mapping.reading[0] + ' reading2homekit: ' + err.stack, err);
      return undefined;
    }
    if (typeof value === 'number' && isNaN(value)) {
      uiderror(uid, mapping.reading[0] + ' not a number: ' + readings[mapping.reading[0].replace(/\.|\#|\[|\]|\$/g, '_')] + ' => ' + value);
      return undefined;
    }

  } else {
    value = FHEM_reading2homekit_(uid, mapping, readings);
  }

  if (value === undefined) {
    if (mapping.default !== undefined) {
      orig = 'mapping.default';
      value = mapping.default;
    } else
      return undefined;

  }

  var defined = undefined;
  if (mapping.homekit2name !== undefined) {
    defined = mapping.homekit2name[value];
    if (defined === undefined)
      defined = '???';
  }

  uidlog(uid, '    caching: ' + (mapping.name ? 'Custom ' + mapping.name : mapping.characteristic_type) + (mapping.subtype ? ':' + mapping.subtype : '') + ': ' +
    value + ' (' + 'as ' + typeof (value) + (defined ? '; means ' + defined : '') + '; from \'' + orig + '\')');
  mapping.cached = value;

  return value;
}

async function cached2Format(uid, mapping, readings) {
  return FHEM_reading2homekit(uid, mapping, readings);
}

module.exports = {
  getAllDevicesAndReadings,
  getClientVersion,
  createDirective,
  getDeviceAndReadings,
  cached2Format,
  checkExceptions,
  checkLinkedDevices,
  sendCmd2Fhem,
  initSync
};
