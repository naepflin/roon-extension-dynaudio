"use strict";

const RoonApi = require("node-roon-api");
const RoonApiVolumeControl = require('node-roon-api-volume-control');
const RoonApiSourceControl = require('node-roon-api-source-control');
const RoonApiSettings = require('node-roon-api-settings');
const net = require('net');
const genericPool = require("generic-pool");
const http = require('http');

const inputType = {
  minijack: 0x01,
  line: 0x02,
  optical: 0x03,
  coax: 0x04,
  usb: 0x05,
  bluetooth: 0x06,
  stream: 0x07
}

const zone = {
  red: 0x01,
  green: 0x02,
  blue: 0x03
}

const roon = new RoonApi({
    extension_id:        'com.naepflin.roon-dynaudio',
    display_name:        "Dynaudio Volume Control",
    display_version:     "1.0.0",
    publisher:           'Ivo Näpflin',
    email:               'git@naepflin.com',
    website:             'https://github.com/naepflin/roon-extension-dynaudio',
});

var mysettings = roon.load_config("settings") || {
    ip: "",
    source: inputType.usb,
    initialvolume: 1,
};

function makelayout(settings) {
  var l = {
    values:    settings,
    layout:    [],
    has_error: false
  };

  l.layout.push({
    type:      "string",
    title:     "IP Address",
    maxlength: 15,
    setting:   "ip",
  });

  l.layout.push({
    type:    "dropdown",
    title:   "Source",
    values:  [
      { value: inputType.usb, title: "USB" },
    ],
    setting: "source",
  });
  l.layout.push({
    type:    "integer",
    title:   "Initial Volume",
    min:     0,
    max:     31,
    setting: "initialvolume",
  });

  return l;
}

const svc_settings = new RoonApiSettings(roon, {
  get_settings: function(cb) {
    cb(makelayout(mysettings));
  },
  save_settings: function(req, isdryrun, settings) {
    let l = makelayout(settings.values);
    req.send_complete(l.has_error ? "NotValid" : "Success", { settings: l });

    if (!isdryrun && !l.has_error) {
      mysettings = l.values;
      svc_settings.update_settings(l);
      // destroy the current socket to reload it with the new settings:
      connectionPool.acquire().then(function(socket) {
        connectionPool.destroy(socket);
      });
      roon.save_config("settings", mysettings);
    }
  }
});

const svc_volume_control = new RoonApiVolumeControl(roon);

var svc_source_control = new RoonApiSourceControl(roon);

roon.init_services({
  provided_services: [ svc_volume_control, svc_source_control, svc_settings ],
});

const initialVolume = isNaN(parseInt(mysettings.initialvolume)) ? 1 : parseInt(mysettings.initialvolume);

const device = {
  state: {
    display_name: "Dynaudio Connect",
    volume_type:  "number",
    volume_min:   0,
    volume_max:   31,
    volume_value: initialVolume,
    volume_step:  1,
    is_muted:     false
  },
  set_volume: function (req, mode, value) {
    let newvol = mode == "absolute" ? value : (this.state.volume_value + value);
    if      (newvol < this.state.volume_min) newvol = this.state.volume_min;
    else if (newvol > this.state.volume_max) newvol = this.state.volume_max;

    if (Math.ceil(newvol) != Math.ceil(this.state.volume_value )) {
      this.state.volume_value = newvol;
      sendVolumeUpdate(newvol);
    }
    req.send_complete("Success");
  },
  set_mute: function (req, action) {
    console.log("set mute");
  }
};

const dynaudioVolumeControl = svc_volume_control.new_device(device);

const factory = {
  create: createSocket,
  destroy: function(socket) {
    socket.end();
  }
};
const opts = {
  max: 1, // maximum size of the pool
  min: 0 // minimum size of the pool
};
const connectionPool = genericPool.createPool(factory, opts);

function createSocket() {
  let connection = net.connect(1901, mysettings.ip);
  connection.on('connect', () => {
    console.log('connected to server'); // TODO: only start sending messages once we're connected! (otherwise we don't hear responses)
  });
  connection.on('data', (data) => {
    console.log(new Date().toISOString() + ': ' + data.toString('hex'));
    processTCPResponse(data);
  });
  connection.on('end', () => {
    console.log('disconnected from server');
  });
  connection.on('error', (e) => {
    console.log('error: ' + e);
    connectionPool.destroy(connection);
  });
  connection.on('close', (had_error) => {
    console.log('close ' + had_error ? "with error" : "without error");
  });
  connection.on('drain', () => {
    console.log('drain');
  });
  connection.on('timeout', () => {
    console.log('timeout');
  });
  return connection;
}

function sendVolumeUpdate(vol) {
  const dynaudioVol = Math.ceil(vol);
  const volumeUp = true; // TODO: Add logic here. Also seems to work without logic
  const commandCode = volumeUp ? 0x13 : 0x14;
  const statusValue = 0x51; // TODO: Add logic here. Works only with USB input and zone Red
  const payload = [0x2F, 0xA0, commandCode, dynaudioVol, statusValue];
  sendPayload(payload);

  dynaudioVolumeControl.update_state({ volume_value: vol }); // TODO: Update only if update is successful
}

function sendInputChange(input) {
  const commandCode = 0x15;
  const statusValue = 0x51; // TODO: Add logic here. Works only with USB input and zone Red
  const payload = [0x2F, 0xA0, commandCode, input, statusValue];
  sendPayload(payload);
}

function sendPayload(payload) {
  const payloadSum = payload.reduce((total, num) => {return total + num;});
  const payloadSize = 0x05;
  const checksum = Math.ceil(payloadSum/255)*255-payloadSum-(payload.length-Math.ceil(payloadSum/255));
  // TODO: If the result is negative add 256

  const message = Buffer.from([0xFF, 0x55, payloadSize].concat(payload, [checksum]));

  const resourcePromise = connectionPool.acquire();
  resourcePromise
    .then(function(socket) {
      socket.write(message);
      connectionPool.release(socket);
    })
    .catch(function(err) {
      console.log("Error: " + err);
    });
}

function processTCPResponse(message) {
  const payloadSize = message[2];
  const checksum = message[message.length-1];
  const payload = message.slice(3, message.length-1);

  // check if the message is a feedback
  if(payload[0] == 0x2e && payload[1] == 0xa0) {
    // check if it's a volume change (0x04 means volume up, 0x05 means volume down):
    if(payload[2] == 0x04 || payload[2] == 0x05) {
      const newvol = payload[3];
      dynaudioVolumeControl.update_state({ volume_value: newvol });;
    }
  }
}

const dynaudioSourceControl = svc_source_control.new_device({
  state: {
    display_name:     "Dynaudio Connect",
    supports_standby: false,
    status: "selected"
  },
  convenience_switch: function (req) {
    sendInputChange(inputType.usb);
    req.send_complete("Success");
  }
});

roon.start_discovery();

// TODO: launch with correct initial value loaded from Connect (or better from Roon!)
// TODO: establish a TCP connection immediately when extension launches
