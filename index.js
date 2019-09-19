'use strict';
var Accessory, Service, StreamController, Categories, UUID;
var crypto = require('crypto');
var ip = require('ip');
var spawn = require('child_process').spawn;

module.exports = function(homebridge) {
  Accessory = homebridge.platformAccessory;
  Service = homebridge.hap.Service;
  StreamController = homebridge.hap.StreamController;
  Categories = homebridge.hap.Accessory.Categories;
  UUID = homebridge.hap.uuid;
  homebridge.registerPlatform("homebridge-cams", "Cams", HomebridgeCams, true);
}

function HomebridgeCams(log, config, api) {
  this.log = log;
  this.config = config || {};
  this.accessories = [];

  if (api) {
    this.api = api;
    this.api.on('didFinishLaunching', this.didFinishLaunching.bind(this));
  }
}

HomebridgeCams.prototype.configureAccessory = function(accessory) {
}

HomebridgeCams.prototype.didFinishLaunching = function() {
  var platform = this;
  if (platform.config.cams) {
    var cams = platform.config.cams;
    cams.forEach(function(config) {
      var name = config.name;
      var source = config.source;
      if (!name || !source) {
        platform.log("Invalid configuration, missing name or source.");
        return;
      }

      var uuid = UUID.generate(name);
      var accessory = new Accessory(name, uuid, Categories.CAMERA);
      var cam = new HomebridgeCam(name, source, config.still, config.debug, platform.log);
      accessory.configureCameraSource(cam);
      platform.accessories.push(accessory);
    });
    platform.api.publishCameraAccessories("Cams", platform.accessories);
  }
}

function HomebridgeCam(name, source, still, debug, log) {
  var self = this;
  this.name = name;
  this.source = source;
  this.still = still;
  this.debug = debug;
  this.log = log;

  this.services = [];
  this.streams = [];
  this.pending = {};
  this.sessions = {};

  let options = {
    proxy: false,
    srtp: true,
    video: {
      resolutions: [[480, 270, 10],[1280, 720, 10]],
      codec: {
        profiles: [0, 1, 2],
        levels: [0, 1, 2]
      }
    },
    audio: {
      codecs: []
    }
  }

  var control = new Service.CameraControl();
  this.services.push(control);
  for (var i = 0; i < 2; i++) {
    var stream = new StreamController(i, options, self);
    self.services.push(stream.service);
    self.streams.push(stream);
  }
}

HomebridgeCam.prototype.handleCloseConnection = function(id) {
  this.streams.forEach(function(controller) {
    controller.handleCloseConnection(id);
  });
}

HomebridgeCam.prototype.handleSnapshotRequest = function(request, callback) {
  let self = this;
  var source = this.still !== undefined ? '-i ' + this.still : '-rtsp_transport tcp -i ' + this.source + ' -frames:v 1';
  let args = source + ' -s '+ request.width + 'x' + request.height + ' -f image2 -';
  if (this.debug) {
    this.log('ffmpeg ' + args);
  }
  let ffmpeg = spawn('ffmpeg', args.split(' '));
  this.log("Snapshot from " + this.name);
  var buffer = Buffer.alloc(0);
  ffmpeg.stdout.on('data', function(data) {
    buffer = Buffer.concat([buffer, data]);
  });
  ffmpeg.on('error', function(error){
    self.log("Snapshot request error");
    if (self.debug) {
      self.log(error);
    }
  });
  ffmpeg.on('close', function(code) {
    callback(undefined, buffer);
  }.bind(this));
}

HomebridgeCam.prototype.prepareStream = function(request, callback) {
  var session = {};
  session["address"] = request["targetAddress"];

  var response = {};
  var address = {};
  let ipaddress = ip.address();
  address["address"] = ipaddress;
  address["type"] = ip.isV4Format(ipaddress) ? "v4" : "v6";
  response["address"] = address;

  let video = request["video"];
  if (video) {
    let ssrcSource = crypto.randomBytes(4);
    ssrcSource[0] = 0;
    let ssrc = ssrcSource.readInt32BE(0, true);
    video["ssrc"] = ssrc;
    session["video"] = video;
    response["video"] = video;
  }
  let audio = request["audio"];
  if (audio) {
    let ssrcSource = crypto.randomBytes(4);
    ssrcSource[0] = 0;
    let ssrc = ssrcSource.readInt32BE(0, true);
    audio["ssrc"] = ssrc;
    session["audio"] = audio;
    response["audio"] = audio;
  }

  this.pending[UUID.unparse(request["sessionID"])] = session;
  callback(response);
}

HomebridgeCam.prototype.handleStreamRequest = function(request) {
  let self = this;
  var sessionIdentifier = request["sessionID"];
  var sessionID = UUID.unparse(sessionIdentifier);
  if (request["type"] == "start") {
    var session = this.pending[sessionID];
    if (session) {
      let args = '-rtsp_transport tcp -i ' + this.source +
        ' -map 0:0 -c:v copy -f rawvideo -payload_type 99' +
        ' -ssrc ' + session["video"]["ssrc"] +
        ' -f rtp -srtp_out_suite AES_CM_128_HMAC_SHA1_80' +
        ' -srtp_out_params ' + Buffer.concat([session["video"]["srtp_key"], session["video"]["srtp_salt"]]).toString('base64') +
        ' srtp://' + session["address"] + ':' + session["video"]["port"] + '?rtcpport=' + session["video"]["port"] + '&localrtcpport=' + session["video"]["port"] + '&pkt_size=1316';
      if (this.debug) {
        this.log('ffmpeg ' + args);
      }
      let ffmpeg = spawn('ffmpeg', args.split(' '));
      this.log("Streaming from " + this.name);
      ffmpeg.stderr.on('data', function(data) {
        if (self.debug) {
          self.log(data.toString());
        }
      });
      ffmpeg.on('error', function(error){
        self.log("Stream request error");
        if (self.debug) {
          self.log(error);
        }
      });
      ffmpeg.on('close', (status) => {
        if (status == null || status == 0 || status == 255) {
        } else {
          self.log("FFmpeg error: " + status);
          for (var i=0; i < self.streams.length; i++) {
            var controller = self.streams[i];
            if (controller.sessionIdentifier === sessionIdentifier) {
              controller.forceStop();
            }
          }
        }
      });
      this.sessions[sessionID] = ffmpeg;
      delete this.pending[sessionID];
    }
  } else if (request["type"] == "stop") {
    var process = this.sessions[sessionID];
    if (process) {
      process.kill('SIGTERM');
    }
    delete this.sessions[sessionID];
  }
}
