"use strict";

var RoonApi = require("node-roon-api");
var RoonApiVolumeControl = require('node-roon-api-volume-control');
var net = require('net');
var ConnectionPool = require('jackpot');

var core;

var roon = new RoonApi({
    extension_id:        'com.naepflin.dynaudiovolume',
    display_name:        "Dynaudio Volume Control",
    display_version:     "1.0.0",
    publisher:           'Ivo Näpflin',
    email:               'git@naepflin.com',
    website:             'https://github.com/naepflin/roon-dynaudio-volume',

    core_paired: function(core_) {
      core = core_;
    },
    core_unpaired: function(core_) {
      core = undefined;
    },
});

var svc_volume_control = new RoonApiVolumeControl(roon);


roon.init_services({
  provided_services: [ svc_volume_control ],
});

var device = {
  state: {
    display_name: "Dynaudio Connect",
    volume_type:  "number",
    volume_min:   0,
    volume_max:   155,
    volume_value: 5,
    volume_step:  1,
    is_muted:     false
  },
  set_volume: function (req, mode, value) {
    let newvol = mode == "absolute" ? value : (this.state.volume_value + value);
    if      (newvol < this.state.volume_min) newvol = this.state.volume_min;
    else if (newvol > this.state.volume_max) newvol = this.state.volume_max;

    if (Math.ceil(newvol / 5) != Math.ceil(this.state.volume_value / 5 )) {
      this.state.volume_value = newvol;
      setVolume(newvol);
    }
    req.send_complete("Success");
  },
  set_mute: function (req, action) {
    console.log("set mute");
  }
};

var dynaudioVolumeControl = svc_volume_control.new_device(device);


roon.start_discovery();

var pool = new ConnectionPool(100);
pool.factory(function () {
  console.log('connection created');
  return net.connect(1901, '192.168.178.30');
});

function setVolume(vol) {
  let dynaudioVol = Math.ceil(vol / 5);

  pool.allocate(function (err, connection) {
    let volumeUp = true; // TODO: Add logic here. Also seems to work without logic
    let commandCode = volumeUp ? 0x13 : 0x14;
    let commandValue = 0x05; // TODO: Add logic here. Works only with USB input
    let statusValue = 0x51; // TODO: Add logic here. Works only with USB input and zone Red
    let payload = [0x2F, 0xA0, commandCode, dynaudioVol, statusValue];

    let payloadSum = payload.reduce((total, num) => {return total + num;});
    let checksum = Math.ceil(payloadSum/255)*255-payloadSum-(payload.length-Math.ceil(payloadSum/255));
    // TODO: If the result is negative add 256

    let message = Buffer.from([0xFF, 0x55, commandValue].concat(payload, [checksum]));
    connection.write(message);
  });

  dynaudioVolumeControl.update_state({ volume_value: vol }); // TODO: Update only if update is successful
}
