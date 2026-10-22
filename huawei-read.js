#!/usr/bin/env node
'use strict';

// Node 12.13.1 compatible. No packages or inverter configuration writes.
const net = require('net');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

// Literal Huawei holding-register addresses. Availability depends on firmware.
// name, address, format, register count, divisor, unit
const REGISTERS = [
  ['model', 30000, 'text', 15, 1, null],
  ['serial_number', 30015, 'text', 10, 1, null],
  ['pv1_voltage', 32016, 'i16', 1, 10, 'V'],
  ['pv1_current', 32017, 'i16', 1, 100, 'A'],
  ['pv2_voltage', 32018, 'i16', 1, 10, 'V'],
  ['pv2_current', 32019, 'i16', 1, 100, 'A'],
  ['input_power', 32064, 'i32', 2, 1000, 'kW'],
  ['line_voltage_ab', 32066, 'u16', 1, 10, 'V'],
  ['line_voltage_bc', 32067, 'u16', 1, 10, 'V'],
  ['line_voltage_ca', 32068, 'u16', 1, 10, 'V'],
  ['phase_a_voltage', 32069, 'u16', 1, 10, 'V'],
  ['phase_b_voltage', 32070, 'u16', 1, 10, 'V'],
  ['phase_c_voltage', 32071, 'u16', 1, 10, 'V'],
  ['phase_a_current', 32072, 'i32', 2, 1000, 'A'],
  ['phase_b_current', 32074, 'i32', 2, 1000, 'A'],
  ['phase_c_current', 32076, 'i32', 2, 1000, 'A'],
  ['peak_active_power_today', 32078, 'i32', 2, 1, 'W'],
  ['active_power', 32080, 'i32', 2, 1, 'W'],
  ['reactive_power', 32082, 'i32', 2, 1, 'var'],
  ['power_factor', 32084, 'i16', 1, 1000, null],
  ['grid_frequency', 32085, 'u16', 1, 100, 'Hz'],
  ['efficiency', 32086, 'u16', 1, 100, '%'],
  ['internal_temperature', 32087, 'i16', 1, 10, 'C'],
  ['insulation_resistance', 32088, 'u16', 1, 1000, 'Mohm'],
  ['device_status', 32089, 'u16', 1, 1, null],
  ['total_yield', 32106, 'u32', 2, 100, 'kWh'],
  ['daily_yield', 32114, 'u32', 2, 100, 'kWh']
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function log(level, message) {
  const now = new Date();
  const pad = (value, width) => String(value).padStart(width || 2, '0');
  const offset = -now.getTimezoneOffset();
  const timestamp = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' +
    pad(now.getDate()) + 'T' + pad(now.getHours()) + ':' + pad(now.getMinutes()) +
    ':' + pad(now.getSeconds()) + '.' + pad(now.getMilliseconds(), 3) +
    (offset >= 0 ? '+' : '-') + pad(Math.floor(Math.abs(offset) / 60)) +
    ':' + pad(Math.abs(offset) % 60);
  // Keep each event on one line, including errors returned by remote peers.
  console.error(timestamp + ' [' + level + '] ' +
    String(message).replace(/[\r\n]+/g, ' '));
}

function parseEnv(text) {
  const values = {};
  text.split(/\r?\n/).forEach((line, index) => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) throw new Error('Invalid .env entry on line ' + (index + 1));
    let value = match[2].trim();
    if (value[0] === '"' || value[0] === "'") {
      const quote = value[0];
      const end = value.indexOf(quote, 1);
      if (end < 0 || !/^(\s*#.*)?$/.test(value.slice(end + 1))) {
        throw new Error('Invalid .env quoting on line ' + (index + 1));
      }
      value = value.slice(1, end);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values[match[1]] = value;
  });
  return values;
}

function loadEnv() {
  try {
    return parseEnv(fs.readFileSync(path.join(__dirname, '.env'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

function options(argv, env) {
  const result = { host: '192.168.200.1', port: 6607, unit: 0, timeout: 15, delay: 2 };
  const keys = {
    host: 'MODBUS_HOST', port: 'MODBUS_PORT', unit: 'MODBUS_UNIT',
    timeout: 'MODBUS_TIMEOUT', delay: 'MODBUS_DELAY'
  };
  Object.keys(keys).forEach(key => {
    if (env && env[keys[key]] !== undefined) {
      result[key] = key === 'host' ? env[keys[key]] : Number(env[keys[key]]);
      if (env[keys[key]].trim() === '') throw new Error(keys[key] + ' must not be empty');
    }
  });
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help') return null;
    const key = argv[i].slice(2);
    if (!argv[i].startsWith('--') || !Object.prototype.hasOwnProperty.call(result, key) ||
        i + 1 === argv.length) throw new Error('Invalid argument: ' + argv[i]);
    result[key] = key === 'host' ? argv[++i] : Number(argv[++i]);
  }
  if (!result.host || !Number.isInteger(result.port) || result.port < 1 || result.port > 65535 ||
      !Number.isInteger(result.unit) || result.unit < 0 || result.unit > 247 ||
      !Number.isFinite(result.timeout) || result.timeout <= 0 ||
      !Number.isFinite(result.delay) || result.delay < 0) {
    throw new Error('Invalid host, port, unit, timeout, or delay');
  }
  return result;
}

function connect(config) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: config.host, port: config.port });
    const timer = setTimeout(() => socket.destroy(new Error('Connection timed out')),
      config.timeout * 1000);
    socket.once('error', error => { clearTimeout(timer); reject(error); });
    socket.once('connect', () => {
      clearTimeout(timer);
      // Keep an error listener between requests, including during the delay.
      socket.on('error', () => {});
      socket.setNoDelay(true);
      resolve(socket);
    });
  });
}

function readRegisters(socket, transaction, config, address, count) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error('Response timed out')),
      config.timeout * 1000);
    function finish(error, data) {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      if (error) reject(error); else resolve(data);
    }
    function onError(error) { finish(error); }
    function onClose() { finish(new Error('Peer closed connection before a complete response')); }
    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 7) return;
      const length = buffer.readUInt16BE(4);
      if (buffer.readUInt16BE(0) !== transaction || buffer.readUInt16BE(2) !== 0 ||
          buffer[6] !== config.unit || length < 2 || length > 254) {
        return finish(new Error('Invalid Modbus response header'));
      }
      if (buffer.length < 6 + length) return;
      if (buffer.length !== 6 + length) return finish(new Error('Unexpected extra response data'));
      const pdu = buffer.slice(7);
      if (pdu[0] === 0x83 && pdu.length === 2) {
        const error = new Error('Modbus exception 0x' + pdu[1].toString(16).padStart(2, '0'));
        error.modbusException = true;
        return finish(error);
      }
      if (pdu[0] !== 3 || pdu[1] !== count * 2 || pdu.length !== 2 + count * 2) {
        return finish(new Error('Unexpected function, byte count, or response size'));
      }
      finish(null, pdu.slice(2));
    }
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    if (socket.destroyed) return finish(new Error('Connection is closed'));
    const request = Buffer.alloc(12);
    request.writeUInt16BE(transaction, 0);
    request.writeUInt16BE(6, 4);
    request[6] = config.unit;
    request[7] = 3; // Read holding registers only.
    request.writeUInt16BE(address, 8);
    request.writeUInt16BE(count, 10);
    socket.write(request);
  });
}

function decode(data, format, divisor) {
  if (format === 'text') return data.toString('ascii').split('\x00')[0].trim();
  const formats = {
    i16: ['readInt16BE', 0x7fff], u16: ['readUInt16BE', 0xffff],
    i32: ['readInt32BE', 0x7fffffff], u32: ['readUInt32BE', 0xffffffff]
  };
  const spec = formats[format];
  const raw = data[spec[0]](0);
  return raw === spec[1] ? null : raw / divisor;
}

async function snapshot(config, progress) {
  progress = progress || (() => {});
  const result = {
    started_at: new Date().toISOString(),
    target: { host: config.host, port: config.port, unit: config.unit },
    readings: {}
  };
  let socket = null;
  let transaction = 0;
  try {
    for (const [name, address, format, count, divisor, unit] of REGISTERS) {
      progress('Reading ' + (transaction + 1) + '/' + REGISTERS.length +
        ': ' + name + ' [' + address + ']');
      const reading = { address: address, unit: unit };
      result.readings[name] = reading;
      try {
        if (!socket || socket.destroyed) {
          socket = await connect(config);
          await sleep(config.delay * 1000);
        }
        const data = await readRegisters(socket, ++transaction, config, address, count);
        reading.raw = data.toString('hex');
        reading.value = decode(data, format, divisor);
        if (reading.value === null) reading.error = 'Device reports unavailable';
        if (reading.error) progress('  ' + reading.error);
      } catch (error) {
        progress('  ' + error.message);
        reading.value = null;
        reading.error = error.message;
        // A valid exception leaves framing intact. Stop on other failures so a
        // late response cannot become the next register's result.
        if (!error.modbusException) {
          if (socket) socket.destroy();
          socket = null;
        }
        // Stop retrying an unreachable target for every candidate register.
        if (!socket) {
          result.error = 'Snapshot incomplete: ' + error.message;
          break;
        }
      }
      if (transaction < REGISTERS.length) await sleep(config.delay * 1000);
    }
  } finally {
    if (socket) socket.destroy();
  }
  result.finished_at = new Date().toISOString();
  return result;
}

// Minimal MQTT 3.1.1 publisher: clean sessions, QoS 1/PUBACK, retained discovery,
// keepalive and Last Will. Plain TCP only, as configured for this LAN.
function mqttString(value) {
  const bytes = Buffer.from(String(value));
  if (bytes.length > 65535) throw new Error('MQTT string is too long');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function mqttPacket(header, body) {
  const length = [];
  let remaining = body.length;
  do {
    let digit = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining) digit |= 128;
    length.push(digit);
  } while (remaining);
  return Buffer.concat([Buffer.from([header].concat(length)), body]);
}

class MqttPublisher extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.pending = new Map();
    this.sequence = 0;
    this.connected = false;
    this.buffer = Buffer.alloc(0);
  }

  async open() {
    const c = this.config;
    this.socket = await connect({ host: c.host, port: c.port, timeout: 15 });
    this.socket.on('error', error => { this.lastError = error.message; });
    this.socket.on('close', () => {
      this.connected = false;
      clearInterval(this.heartbeat);
      this.pending.forEach(p => p.reject(new Error('MQTT connection closed')));
      this.pending.clear();
      this.emit('closed', this.lastError || 'Connection closed by broker or network');
    });
    this.socket.on('data', chunk => {
      try { this.receive(chunk); } catch (error) { this.socket.destroy(error); }
    });
    const accepted = this.wait('connack');
    const flags = 2 | 4 | 8 | 32 | (c.username ? 128 | 64 : 0);
    const variable = Buffer.concat([mqttString('MQTT'), Buffer.from([4, flags, 0, 30])]);
    const payload = [mqttString(c.clientId), mqttString(c.topic + '/status'), mqttString('offline')];
    if (c.username) payload.push(mqttString(c.username), mqttString(c.password));
    this.socket.write(mqttPacket(0x10, Buffer.concat([variable].concat(payload))));
    try { await accepted; } catch (error) { this.socket.destroy(); throw error; }
    this.connected = true;
    this.heartbeat = setInterval(() => {
      if (this.pingAt && Date.now() - this.pingAt > 15000) {
        this.socket.destroy(new Error('MQTT keepalive timed out'));
      } else if (!this.pingAt) {
        this.pingAt = Date.now();
        this.socket.write(Buffer.from([0xc0, 0]));
      }
    }, 10000);
  }

  wait(id) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('MQTT acknowledgement timed out'));
        this.socket.destroy();
      }, 15000);
      this.pending.set(id, {
        resolve: () => { clearTimeout(timer); this.pending.delete(id); resolve(); },
        reject: error => { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > 65536) throw new Error('Oversized MQTT response');
    while (this.buffer.length >= 2) {
      let length = 0;
      let multiplier = 1;
      let offset = 1;
      let digit;
      do {
        if (offset >= this.buffer.length) return;
        if (offset > 4) throw new Error('Invalid MQTT length');
        digit = this.buffer[offset++];
        length += (digit & 127) * multiplier;
        multiplier *= 128;
      } while (digit & 128);
      if (length > 65536) throw new Error('Oversized MQTT response');
      if (this.buffer.length < offset + length) return;
      const header = this.buffer[0];
      const body = this.buffer.slice(offset, offset + length);
      this.buffer = this.buffer.slice(offset + length);
      if (header === 0x20 && body.length === 2 && body[0] === 0) {
        const pending = this.pending.get('connack');
        if (!pending) throw new Error('Unexpected MQTT CONNACK');
        if (body[1] !== 0) pending.reject(new Error('MQTT connection refused, code ' + body[1]));
        else pending.resolve();
      } else if (header === 0x40 && body.length === 2) {
        const pending = this.pending.get(body.readUInt16BE(0));
        if (pending) pending.resolve();
      } else if (header === 0xd0 && body.length === 0) {
        this.pingAt = 0;
      } else {
        throw new Error('Unexpected MQTT response');
      }
    }
  }

  async publish(topic, value, retain) {
    if (!this.connected) throw new Error('MQTT is disconnected');
    const id = this.sequence = (this.sequence % 65535) + 1;
    const identifier = Buffer.alloc(2);
    identifier.writeUInt16BE(id);
    const acknowledged = this.wait(id);
    this.socket.write(mqttPacket(retain ? 0x33 : 0x32,
      Buffer.concat([mqttString(topic), identifier, Buffer.from(String(value))])));
    await acknowledged;
  }

  close() {
    clearInterval(this.heartbeat);
    if (this.socket) this.socket.destroy(); // Ungraceful close triggers offline Last Will.
  }
}

// key, name, unit, device class, state class
const ENTITIES = [
  ['active_power_w', 'Active power', 'W', 'power', 'measurement'],
  ['daily_yield_kwh', 'Daily yield', 'kWh', 'energy', 'total_increasing'],
  ['total_yield_kwh', 'Total yield', 'kWh', 'energy', 'total_increasing'],
  ['peak_active_power_today_w', 'Peak active power today', 'W', 'power', 'measurement'],
  ['input_power_kw', 'Input power', 'kW', 'power', 'measurement'],
  ['pv1_voltage_v', 'PV1 voltage', 'V', 'voltage', 'measurement'],
  ['pv1_current_a', 'PV1 current', 'A', 'current', 'measurement'],
  ['pv2_voltage_v', 'PV2 voltage', 'V', 'voltage', 'measurement'],
  ['pv2_current_a', 'PV2 current', 'A', 'current', 'measurement'],
  ['internal_temperature_c', 'Internal temperature', '°C', 'temperature', 'measurement'],
  ['device_status', 'Device status', null, null, null],
  ['device_status_code', 'Device status code', null, null, null]
];

function bridgeOptions(env) {
  function integer(key, fallback, min, max) {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error('Invalid ' + key);
    return value;
  }
  let broker;
  try { broker = new URL(env.MQTT_BROKER_URL); }
  catch (_) { throw new Error('Set MQTT_BROKER_URL to mqtt://hostname:1883 in the Pi .env'); }
  if (broker.protocol !== 'mqtt:' || !broker.hostname || broker.username || broker.password ||
      (broker.pathname && broker.pathname !== '/') || broker.search || broker.hash) {
    throw new Error('MQTT_BROKER_URL must be mqtt://hostname:port; set credentials separately');
  }
  const password = env.MQTT_PASSWORD;
  if (!env.MQTT_USER || !password) throw new Error('Set MQTT_USER and MQTT_PASSWORD');
  const port = broker.port ? Number(broker.port) : 1883;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid MQTT broker port');
  const topic = env.MQTT_TOPIC_PREFIX || 'huawei';
  const discovery = env.HA_DISCOVERY_PREFIX || 'homeassistant';
  if ([topic, discovery].some(t => /[+#\x00]/.test(t) || t.endsWith('/'))) {
    throw new Error('Invalid MQTT topic prefix');
  }
  return {
    host: broker.hostname.replace(/^\[|\]$/g, ''), port: port,
    username: env.MQTT_USER, password: password,
    topic: topic, discovery: discovery, name: env.HA_DEVICE_NAME || 'Huawei Inverter',
    pollInterval: integer('POLL_INTERVAL', 15, 5, 86400) * 1000
  };
}

function discoveryMessages(config, identity) {
  const id = 'huawei_' + identity.serial.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  const device = {
    identifiers: [id], name: config.name, manufacturer: 'Huawei',
    model: identity.model, serial_number: identity.serial
  };
  return ENTITIES.map(([key, name, unit, deviceClass, stateClass]) => {
    const power = key === 'active_power_w';
    const stateTopic = config.topic + (power ? '/active_power' : '/telemetry');
    const payload = {
      name: name, unique_id: id + '_' + key, device: device,
      state_topic: stateTopic, availability_mode: 'all',
      availability: [{ topic: config.topic + '/status' }],
      expire_after: Math.ceil(config.pollInterval * 3 / 1000)
    };
    if (!power) {
      payload.value_template = '{{ value_json.' + key + ' }}';
      payload.availability.push({
        topic: stateTopic,
        value_template: '{{ "online" if value_json.' + key +
          ' is defined and value_json.' + key + ' is not none else "offline" }}'
      });
    }
    if (unit) payload.unit_of_measurement = unit;
    if (deviceClass) payload.device_class = deviceClass;
    if (stateClass) payload.state_class = stateClass;
    if (key === 'device_status_code') payload.entity_category = 'diagnostic';
    return { topic: config.discovery + '/sensor/' + id + '/' + key + '/config', payload: payload };
  });
}

function telemetry(values) {
  const status = values.device_status;
  const names = {
    0: 'standby_initializing', 1: 'standby_insulation_detection',
    2: 'standby_irradiation_detection', 3: 'standby_grid_detection',
    256: 'starting', 512: 'running', 513: 'running_power_limited',
    514: 'running_self_derating', 768: 'shutdown_fault',
    769: 'shutdown_command', 770: 'shutdown_ovgr', 771: 'shutdown_communication_loss',
    772: 'shutdown_power_limited', 773: 'shutdown_manual_start_required',
    40960: 'standby_no_irradiation'
  };
  return {
    timestamp: new Date().toISOString(), active_power_w: values.active_power,
    daily_yield_kwh: values.daily_yield, total_yield_kwh: values.total_yield,
    peak_active_power_today_w: values.peak_active_power_today,
    input_power_kw: values.input_power,
    pv1_voltage_v: values.pv1_voltage, pv1_current_a: values.pv1_current,
    pv2_voltage_v: values.pv2_voltage, pv2_current_a: values.pv2_current,
    // This firmware reports zero temperature while asleep, not ambient 0 °C.
    internal_temperature_c: status === 40960 && values.internal_temperature === 0 ?
      null : values.internal_temperature,
    device_status_code: status,
    device_status: status === null ? null : (names[status] || 'unknown_' + status)
  };
}

async function runBridge(modbus, config) {
  let stopped = false;
  let socket = null;
  let mqtt = null;
  let identity = null;
  let transaction = 0;
  let lastRequest = 0;
  const stop = () => {
    log('INFO', 'Shutdown requested; closing connections and triggering MQTT offline Last Will.');
    stopped = true;
    if (socket) socket.destroy();
    if (mqtt) mqtt.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  async function read(address, count) {
    if (stopped) throw new Error('Stopping');
    if (!socket || socket.destroyed) {
      log('INFO', 'Connecting to Modbus ' + modbus.host + ':' + modbus.port +
        ', unit ' + modbus.unit + '.');
      socket = await connect(modbus);
      log('INFO', 'Modbus connected.');
      lastRequest = Date.now();
    }
    await sleep(Math.max(0, lastRequest + modbus.delay * 1000 - Date.now()));
    if (stopped) throw new Error('Stopping');
    transaction = (transaction % 65535) + 1;
    try { return await readRegisters(socket, transaction, modbus, address, count); }
    catch (error) {
      error.message = 'Modbus registers ' + address + '–' + (address + count - 1) + ': ' + error.message;
      throw error;
    }
    finally { lastRequest = Date.now(); }
  }
  async function group(address, count, names, values) {
    try {
      const data = await read(address, count);
      names.forEach(name => {
        const spec = REGISTERS.find(r => r[0] === name);
        const offset = (spec[1] - address) * 2;
        values[name] = decode(data.slice(offset, offset + spec[3] * 2), spec[2], spec[4]);
      });
    } catch (error) {
      if (!error.modbusException) throw error;
      log('WARN', error.message + '; falling back to individual reads.');
      // Some firmware accepts individual registers but rejects a larger range.
      for (const name of names) {
        const spec = REGISTERS.find(r => r[0] === name);
        try { values[name] = decode(await read(spec[1], spec[3]), spec[2], spec[4]); }
        catch (individual) {
          if (!individual.modbusException) throw individual;
          values[name] = null;
          log('WARN', name + ' unavailable: ' + individual.message);
        }
      }
    }
  }
  let retry = 2000;
  while (!stopped) {
    try {
      if (!identity) {
        log('INFO', 'Reading inverter identity.');
        const model = decode(await read(30000, 15), 'text', 1);
        const serial = decode(await read(30015, 10), 'text', 1);
        if (!model || !serial) throw new Error('Inverter identity is unavailable');
        identity = { model: model, serial: serial };
        log('INFO', 'Inverter identified: ' + model + '.');
      }
      if (!mqtt || !mqtt.connected) {
        if (mqtt) mqtt.close();
        mqtt = new MqttPublisher(Object.assign({}, config, {
          clientId: 'huawei_' + identity.serial.toLowerCase().replace(/[^a-z0-9_-]/g, '_')
        }));
        mqtt.on('closed', reason => {
          if (!stopped) log('WARN', 'MQTT disconnected: ' + reason);
        });
        log('INFO', 'Connecting to MQTT ' + config.host + ':' + config.port + '.');
        await mqtt.open();
        log('INFO', 'MQTT connected; marking device offline until fresh readings are published.');
        await mqtt.publish(config.topic + '/status', 'offline', true);
        for (const message of discoveryMessages(config, identity)) {
          await mqtt.publish(message.topic, JSON.stringify(message.payload), true);
        }
        log('INFO', 'Home Assistant discovery acknowledged: ' + ENTITIES.length +
          ' entities under "' + config.name + '".');
      }
      let nextPoll = 0;
      while (!stopped && mqtt.connected) {
        const now = Date.now();
        if (now >= nextPoll) {
          log('INFO', 'Reading full telemetry.');
          const values = {};
          await group(32016, 4, ['pv1_voltage', 'pv1_current', 'pv2_voltage', 'pv2_current'], values);
          await group(32064, 26, ['input_power', 'peak_active_power_today', 'active_power',
            'internal_temperature', 'device_status'], values);
          await group(32106, 2, ['total_yield'], values);
          await group(32114, 2, ['daily_yield'], values);
          if (values.active_power === null) throw new Error('Active power is unavailable');
          const state = telemetry(values);
          await mqtt.publish(config.topic + '/telemetry', JSON.stringify(state), false);
          await mqtt.publish(config.topic + '/active_power', values.active_power, false);
          await mqtt.publish(config.topic + '/status', 'online', true);
          log('INFO', 'Telemetry published; device online: power=' + state.active_power_w +
            ' W, today=' + state.daily_yield_kwh + ' kWh, total=' + state.total_yield_kwh +
            ' kWh, status=' + state.device_status + ', temperature=' +
            (state.internal_temperature_c === null ? 'unavailable' : state.internal_temperature_c + ' C') +
            '; cycle=' + ((Date.now() - now) / 1000).toFixed(1) + 's.');
          nextPoll = now + config.pollInterval;
          if (Date.now() >= nextPoll) {
            log('WARN', 'Read/publish cycle exceeded POLL_INTERVAL=' + config.pollInterval / 1000 +
              's; starting the next cycle after completion, without overlapping requests.');
          }
          retry = 2000;
        }
        await sleep(250);
      }
    } catch (error) {
      if (!stopped) log('ERROR', 'Bridge cycle failed: ' + error.message);
      if (mqtt && mqtt.connected) {
        try { await mqtt.publish(config.topic + '/status', 'offline', true); }
        catch (_) { mqtt.close(); }
        if (!stopped) log('WARN', 'Device offline; readings will resume after recovery.');
      }
    }
    if (socket) socket.destroy();
    socket = null;
    if (!stopped) {
      log('WARN', 'Retrying in ' + retry / 1000 + ' seconds.');
      for (let elapsed = 0; elapsed < retry && !stopped; elapsed += 250) await sleep(250);
      retry = Math.min(retry * 2, 60000);
    }
  }
  if (socket) socket.destroy();
  if (mqtt) mqtt.close();
  log('INFO', 'Bridge stopped.');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    console.log('Usage: node huawei-read.js [--host 192.168.200.1] [--port 6607]');
    console.log('       [--unit 0] [--timeout 15] [--delay 2]');
    console.log('Continuously publishes MQTT with Home Assistant discovery by default.');
    console.log('Add --once to print one JSON snapshot without MQTT.');
    console.log('Loads .env beside this script; environment variables and CLI flags override it.');
    console.log('Timeout and inter-request delay are in seconds. Close FusionSolar first.');
    return;
  }
  const env = Object.assign({}, loadEnv(), process.env);
  const config = options(argv.filter(arg => arg !== '--once'), env);
  if (!argv.includes('--once')) {
    const bridge = bridgeOptions(env);
    log('INFO', 'Starting Huawei Modbus/MQTT bridge; poll interval=' +
      bridge.pollInterval / 1000 +
      's, Modbus timeout=' + config.timeout + 's, request delay=' + config.delay + 's. Press Ctrl+C to stop.');
    await runBridge(config, bridge);
    return;
  }
  log('INFO', 'Starting read-only snapshot; allow about one minute. Progress is on stderr.');
  log('INFO', 'Connecting to ' + config.host + ':' + config.port + ', unit ' + config.unit +
    '; timeout ' + config.timeout + 's, delay ' + config.delay + 's.');
  const result = await snapshot(config, message => log('INFO', message));
  console.log(JSON.stringify(result, null, 2));
  log(result.error ? 'ERROR' : 'INFO', result.error ? result.error : 'Snapshot complete.');
  if (result.error || !Object.values(result.readings).some(r => r.value !== null)) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch(error => { log('ERROR', error.message); process.exitCode = 1; });
}

module.exports = {
  REGISTERS, parseEnv, options, decode, snapshot, bridgeOptions,
  mqttString, mqttPacket, MqttPublisher, discoveryMessages, telemetry, log
};
