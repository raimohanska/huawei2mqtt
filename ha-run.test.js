'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { configEnvironment } = require('./ha-run');
const app = require('./config.json');
const { options, bridgeOptions, main } = require('./huawei-read');

function configuration() {
  return Object.assign({}, app.options, {
    MQTT_USER: 'test-user', MQTT_PASSWORD: 'test-placeholder'
  });
}

test('all Configuration fields map to reader settings without loading .env', () => {
  const env = configEnvironment(configuration());
  assert.deepEqual(Object.keys(env).sort(), Object.keys(app.schema).sort());
  assert.ok(Object.values(env).every(value => typeof value === 'string'));
  assert.equal(options([], env).port, 6607);
  assert.equal(options([], env).unit, 0);
  assert.equal(bridgeOptions(env).host, 'core-mosquitto');
  assert.equal(bridgeOptions(env).pollInterval, 15000);
  assert.equal(app.schema.MQTT_PASSWORD, 'password');
});

test('unknown settings are not passed through', () => {
  const env = configEnvironment(Object.assign(configuration(), { NODE_OPTIONS: 'ignored' }));
  assert.equal(env.NODE_OPTIONS, undefined);
});

test('invalid settings are rejected before any network connection', () => {
  for (const [key, value] of [
    ['MODBUS_HOST', ' '], ['MODBUS_PORT', 0], ['MODBUS_UNIT', 248],
    ['MODBUS_TIMEOUT', 0], ['MODBUS_DELAY', -1], ['POLL_INTERVAL', 4],
    ['MQTT_BROKER_URL', 'https://example.invalid'], ['MQTT_USER', ''],
    ['MQTT_PASSWORD', ''], ['MQTT_TOPIC_PREFIX', 'bad/#'],
    ['HA_DISCOVERY_PREFIX', ''], ['HA_DEVICE_NAME', '']
  ]) {
    assert.throws(() => configEnvironment(Object.assign(configuration(), { [key]: value })));
  }
  assert.throws(() => configEnvironment(null));
  assert.throws(() => configEnvironment({}));
});

test('reader accepts supplied settings without reading a credential file', async () => {
  const original = fs.readFileSync;
  fs.readFileSync = () => { throw new Error('File access forbidden in this test'); };
  try {
    // Supplied empty settings must fail MQTT validation, not read a file or
    // fall back to the host environment. Validation precedes networking.
    await assert.rejects(main([], {}), /Set MQTT_BROKER_URL/);
  } finally {
    fs.readFileSync = original;
  }
});

test('Docker build context includes only the app runtime files', () => {
  const allowlist = fs.readFileSync('.dockerignore', 'utf8')
    .split('\n').filter(line => line.startsWith('!'));
  assert.deepEqual(allowlist, [
    '!Dockerfile', '!.dockerignore', '!huawei-read.js', '!ha-run.js', '!config.json', '!LICENSE'
  ]);
});
