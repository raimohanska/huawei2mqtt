'use strict';

const path = require('node:path');

function loadConfig() {
  // Credentials are consumed only by application code, never printed or returned
  // through diagnostics. Existing process environment values take precedence.
  try {
    process.loadEnvFile(path.join(__dirname, '.env'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Could not load exporter configuration.');
  }
  const names = ['HUAWEI_LOGIN_PAGE', 'HUAWEI_USERNAME', 'HUAWEI_PASSWORD'];
  if (names.some(name => !process.env[name])) {
    throw new Error('Set HUAWEI_LOGIN_PAGE, HUAWEI_USERNAME and HUAWEI_PASSWORD in report_exporter/.env.');
  }
  let url;
  try { url = new URL(process.env.HUAWEI_LOGIN_PAGE); }
  catch { throw new Error('HUAWEI_LOGIN_PAGE must be an HTTPS URL.'); }
  if (url.protocol !== 'https:') throw new Error('HUAWEI_LOGIN_PAGE must be an HTTPS URL.');
  return {
    loginPage: process.env.HUAWEI_LOGIN_PAGE,
    username: process.env.HUAWEI_USERNAME,
    password: process.env.HUAWEI_PASSWORD
  };
}

module.exports = { loadConfig };
