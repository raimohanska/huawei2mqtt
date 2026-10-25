'use strict';

const path = require('node:path');
const { readdir } = require('node:fs/promises');
const ExcelJS = require('exceljs');
const { loadEnv } = require('./config');
const { validateDate, plantTime } = require('./dates');
const { validateCsv } = require('./validate-csv');
const { ExporterError, describeError } = require('./errors');
const { log } = require('./logger');
const DAILY_ROOT = path.join(__dirname, 'exports', '134568461', 'daily');
const BATCH_SIZE = 1000;

function influxConfig(env) {
  const names = ['INFLUX_URL', 'INFLUX_TOKEN', 'INFLUX_ORG', 'INFLUX_BUCKET', 'INFLUX_MEASUREMENT', 'INFLUX_TAGS'];
  if (names.some(name => typeof env[name] !== 'string' || !env[name].trim())) {
    throw new ExporterError('INFLUX_SETTINGS_MISSING', {}, { retryable: false });
  }
  let url;
  try { url = new URL(env.INFLUX_URL); }
  catch { throw new ExporterError('INFLUX_URL_INVALID', {}, { retryable: false }); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ExporterError('INFLUX_URL_INVALID', {}, { retryable: false });
  }
  if (names.some(name => /[\r\n]/.test(env[name]))) {
    throw new ExporterError('INFLUX_SETTINGS_INVALID', {}, { retryable: false });
  }
  const tags = new Map();
  for (const entry of env.INFLUX_TAGS.split(',')) {
    const colon = entry.indexOf(':');
    const key = entry.slice(0, colon).trim();
    const value = entry.slice(colon + 1).trim();
    if (colon <= 0 || !key || !value || tags.has(key)) {
      throw new ExporterError('INFLUX_TAGS_INVALID', {}, { retryable: false });
    }
    tags.set(key, value);
  }
  return { url: url.href, token: env.INFLUX_TOKEN, org: env.INFLUX_ORG,
    bucket: env.INFLUX_BUCKET, measurement: env.INFLUX_MEASUREMENT, tags };
}

async function readMonthlyYield(csvPath, month) {
  const workbook = new ExcelJS.Workbook();
  const sheet = await workbook.csv.readFile(csvPath, { map: value => value });
  await validateCsv(csvPath, month, { sheet });
  const headers = sheet.getRow(1).values.slice(1);
  const yieldColumn = headers.indexOf('PV Yield (kWh)') + 1;
  const points = [];
  sheet.eachRow((row, index) => {
    if (index === 1) return;
    const date = row.getCell(1).text.slice(0, 10);
    const raw = row.getCell(yieldColumn).text;
    // Monthly rows contain daily totals; blank production is zero.
    const yieldKwh = raw === '' ? 0 : Number(raw);
    if (!Number.isFinite(yieldKwh)) throw new ExporterError('DAILY_YIELD_INVALID', {}, { retryable: false });
    points.push({ date, yieldKwh, timestamp: plantTime(date, 21) / 1000 });
  });
  return points.sort((a, b) => a.date.localeCompare(b.date));
}

async function readDailyYield(date, { root = DAILY_ROOT } = {}) {
  validateDate(date);
  const month = date.slice(0, 7);
  const csvPath = path.join(root, date.slice(0, 4), month + '.csv');
  const matches = (await readMonthlyYield(csvPath, month)).filter(point => point.date === date);
  if (matches.length !== 1) throw new ExporterError('DAILY_ROW_NOT_FOUND', {}, { retryable: false });
  return matches[0];
}

async function readAllDailyYields({ root = DAILY_ROOT } = {}) {
  const years = (await readdir(root, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && /^\d{4}$/.test(entry.name)).map(entry => entry.name).sort();
  const points = [];
  let files = 0;
  for (const year of years) {
    const months = (await readdir(path.join(root, year), { withFileTypes: true }))
      .filter(entry => entry.isFile() && new RegExp('^' + year + '-\\d{2}\\.csv$').test(entry.name))
      .map(entry => entry.name).sort();
    for (const file of months) {
      points.push(...await readMonthlyYield(path.join(root, year, file), file.slice(0, 7)));
      files++;
    }
  }
  if (!points.length) throw new ExporterError('DAILY_ROW_NOT_FOUND', {}, { retryable: false });
  return { points, files };
}

function lineProtocol(config, point) {
  const escape = (value, tag) => String(value).replace(/\\/g, '\\\\').replace(tag ? /[ ,=]/g : /[ ,]/g, '\\$&');
  const tags = [...config.tags].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => escape(key, true) + '=' + escape(value, true));
  return escape(config.measurement, false) + ',' + tags.join(',') +
    ' value=' + point.yieldKwh + ' ' + point.timestamp;
}

async function writeDailyPoint(config, point, { fetchImpl = fetch } = {}) {
  return writePoints(config, [point], { fetchImpl });
}

async function writePoints(config, points, { fetchImpl = fetch } = {}) {
  const url = new URL(config.url);
  url.pathname = url.pathname.replace(/\/$/, '') + '/api/v2/write';
  url.search = new URLSearchParams({ org: config.org, bucket: config.bucket, precision: 's' }).toString();
  let response;
  try {
    // Bounded batches, no automatic retries or redirects.
    response = await fetchImpl(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: 'Token ' + config.token, 'Content-Type': 'text/plain; charset=utf-8' },
      body: points.map(point => lineProtocol(config, point)).join('\n') + '\n'
    });
  } catch {
    throw new ExporterError('INFLUX_WRITE_FAILED', {}, { retryable: false });
  }
  if (response.status !== 204) {
    await response.body?.cancel().catch(() => {});
    throw new ExporterError('INFLUX_WRITE_REJECTED', { status: response.status }, { retryable: false });
  }
}

function options(argv) {
  const result = { dryRun: false };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--help') return { help: true };
    if (argv[index] === '--dry-run') result.dryRun = true;
    else if (argv[index] === '--all') result.all = true;
    else if (argv[index] === '--date') {
      if (result.date) throw new ExporterError('IMPORT_OPTION_INVALID', {}, { retryable: false });
      result.date = validateDate(argv[++index] || '');
    }
    else throw new ExporterError('IMPORT_OPTION_INVALID', {}, { retryable: false });
  }
  if (result.all && result.date) throw new ExporterError('IMPORT_OPTION_INVALID', {}, { retryable: false });
  if (!result.date && !result.all) throw new ExporterError('IMPORT_DATE_REQUIRED', {}, { retryable: false });
  return result;
}

async function main(argv) {
  const config = options(argv);
  if (config.help) {
    log.info('Usage: npm run influx:import -- (--date YYYY-MM-DD | --all) [--dry-run]\n--all imports every available monthly CSV in batches of ' + BATCH_SIZE + ' points.');
    return;
  }
  if (config.all) {
    // Validate all files before making any database writes.
    const { points, files } = await readAllDailyYields();
    log.info('Selected ' + points.length + ' daily points from ' + files + ' monthly CSVs: ' +
      points[0].date + ' through ' + points.at(-1).date + '; field=value; Europe/Helsinki 21:00.');
    if (config.dryRun) { log.info('Dry run: no InfluxDB write.'); return; }
    loadEnv();
    const influx = influxConfig(process.env);
    for (let start = 0; start < points.length; start += BATCH_SIZE) {
      const batch = points.slice(start, start + BATCH_SIZE);
      await writePoints(influx, batch);
      log.info('Imported ' + (start + batch.length) + '/' + points.length + ' points (HTTP 204).');
    }
    return;
  }
  const point = await readDailyYield(config.date);
  log.info('Selected ' + point.date + ': value=' + point.yieldKwh + ' kWh; timestamp=' +
    new Date(point.timestamp * 1000).toISOString() + ' (Europe/Helsinki 21:00).');
  if (config.dryRun) { log.info('Dry run: no InfluxDB write.'); return; }
  loadEnv();
  await writeDailyPoint(influxConfig(process.env), point);
  log.info('Inserted 1 daily-yield point for ' + point.date + ' (HTTP 204).');
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(error => {
    // Never expose response bodies, URLs, tokens, or raw network errors.
    log.error(describeError(error));
    process.exitCode = 1;
  });
}

module.exports = { influxConfig, readDailyYield, readMonthlyYield, readAllDailyYields, lineProtocol, writeDailyPoint, writePoints, options };
