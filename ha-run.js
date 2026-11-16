'use strict';

const fs = require('node:fs');
const { main, options, bridgeOptions, log } = require('./huawei-read');
const { schema } = require('./config.json');

function configEnvironment(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Invalid app configuration.');
  }
  // Only explicitly supported settings are passed to the reader. Do not merge
  // process.env or load .env: the HA Configuration page is the source of truth.
  const env = {};
  for (const key of Object.keys(schema)) {
    if (config[key] === undefined || config[key] === null ||
        !['string', 'number'].includes(typeof config[key])) {
      throw new Error('Missing or invalid app setting: ' + key);
    }
    env[key] = String(config[key]);
  }
  if (!env.MODBUS_HOST.trim() || !env.MQTT_TOPIC_PREFIX.trim() ||
      !env.HA_DISCOVERY_PREFIX.trim() || !env.HA_DEVICE_NAME.trim()) {
    throw new Error('App settings must not be blank.');
  }
  options([], env);
  bridgeOptions(env);
  return env;
}

async function run() {
  let env;
  try {
    env = configEnvironment(JSON.parse(fs.readFileSync('/data/options.json', 'utf8')));
  } catch (_) {
    // Never include input, parser exceptions, or credentials in logs.
    log('ERROR', 'Invalid app configuration. Check Modbus and MQTT settings on the Configuration page.');
    process.exitCode = 1;
    return;
  }
  await main([], env);
}

if (require.main === module) {
  run().catch(() => {
    log('ERROR', 'Huawei bridge stopped unexpectedly.');
    process.exitCode = 1;
  });
}

module.exports = { configEnvironment };
