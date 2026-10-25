'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { influxConfig, readDailyYield, lineProtocol, writeDailyPoint, options } = require('./influx-import');
const { describeError } = require('./errors');

const ENV = {
  INFLUX_URL: 'http://127.0.0.1:8086/custom/', INFLUX_TOKEN: 'mock-private-token',
  INFLUX_ORG: 'test org', INFLUX_BUCKET: 'test bucket',
  INFLUX_MEASUREMENT: 'energy-daily', INFLUX_TAGS: 'device:solar,location:autotalli'
};
const POINT = { date: '2023-05-01', yieldKwh: 32.64, timestamp: 1682888400 };

async function withCsv(work) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fusionsolar-influx-'));
  try {
    await fs.mkdir(path.join(root, '2023'));
    await fs.writeFile(path.join(root, '2023', '2023-05.csv'),
      'Statistical Period,PV Yield (kWh),Inverter Yield (kWh),Total Yield (kWh)\r\n' +
      '2023-05-01,32.64,32.64,1222.05\r\n2023-05-02,,,1222.05\r\n2023-05-03,0,0,1222.05\r\n');
    await work(root);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('one date uses its monthly daily PV yield, not cumulative yield or a monthly sum', async () => {
  await withCsv(async root => {
    assert.deepEqual(await readDailyYield('2023-05-01', { root }), POINT);
    assert.equal(new Date(POINT.timestamp * 1000).toISOString(), '2023-04-30T21:00:00.000Z');
  });
});

test('blank daily production and explicit zero both become zero; absent dates are not invented', async () => {
  await withCsv(async root => {
    assert.equal((await readDailyYield('2023-05-02', { root })).yieldKwh, 0);
    assert.equal((await readDailyYield('2023-05-03', { root })).yieldKwh, 0);
    await assert.rejects(readDailyYield('2023-05-04', { root }), error => error.code === 'DAILY_ROW_NOT_FOUND');
  });
});

test('winter daily timestamps use Helsinki midnight as well', async () => {
  await withCsv(async root => {
    await fs.writeFile(path.join(root, '2023', '2023-01.csv'),
      'Statistical Period,PV Yield (kWh),Inverter Yield (kWh)\r\n2023-01-01,0,0\r\n');
    const point = await readDailyYield('2023-01-01', { root });
    assert.equal(new Date(point.timestamp * 1000).toISOString(), '2022-12-31T22:00:00.000Z');
  });
});

test('measurement and tags are supplied by configuration and line-protocol escaping is applied', () => {
  const config = influxConfig({ ...ENV, INFLUX_MEASUREMENT: 'energy daily,west', INFLUX_TAGS: 'device:solar array,location:garage=west' });
  assert.equal(lineProtocol(config, POINT),
    'energy\\ daily\\,west,device=solar\\ array,location=garage\\=west yield_kwh=32.64 1682888400');
  assert.throws(() => influxConfig({ ...ENV, INFLUX_TOKEN: '' }), error => error.code === 'INFLUX_SETTINGS_MISSING');
  assert.throws(() => influxConfig({ ...ENV, INFLUX_TAGS: 'device:solar,device:other' }), error => error.code === 'INFLUX_TAGS_INVALID');
  assert.throws(() => influxConfig({ ...ENV, INFLUX_MEASUREMENT: 'energy\nextra' }), error => error.code === 'INFLUX_SETTINGS_INVALID');
});

test('insertion makes exactly one POST containing one point and one numeric field', async () => {
  const calls = [];
  await writeDailyPoint(influxConfig(ENV), POINT, { fetchImpl: async (url, request) => {
    calls.push({ url, request });
    return { status: 204 };
  } });
  assert.equal(calls.length, 1);
  const { url, request } = calls[0];
  assert.equal(url.pathname, '/custom/api/v2/write');
  assert.equal(url.searchParams.get('org'), 'test org');
  assert.equal(url.searchParams.get('bucket'), 'test bucket');
  assert.equal(url.searchParams.get('precision'), 's');
  assert.equal(request.headers.Authorization, 'Token mock-private-token');
  assert.equal(request.method, 'POST');
  assert.equal(request.redirect, 'error');
  assert.equal(request.body, 'energy-daily,device=solar,location=autotalli yield_kwh=32.64 1682888400\n');
  assert.equal(request.body.trim().split('\n').length, 1);
});

test('write failures do not retry or expose tokens, URLs, or response bodies', async () => {
  let calls = 0;
  await assert.rejects(writeDailyPoint(influxConfig(ENV), POINT, { fetchImpl: async () => {
    calls++;
    return { status: 401, body: { cancel: async () => {} } };
  } }), error => {
    assert.equal(error.code, 'INFLUX_WRITE_REJECTED');
    assert.equal(error.details.status, 401);
    assert.ok(!describeError(error).includes(ENV.INFLUX_TOKEN));
    return true;
  });
  assert.equal(calls, 1);
  await assert.rejects(writeDailyPoint(influxConfig(ENV), POINT, { fetchImpl: async () => {
    throw new Error('Request failed: ' + ENV.INFLUX_TOKEN + ' ' + ENV.INFLUX_URL);
  } }), error => describeError(error) === 'INFLUX_WRITE_FAILED {}');
});

test('import requires an explicit single date and has no bulk mode', () => {
  assert.deepEqual(options(['--date', '2023-05-01', '--dry-run']), { date: '2023-05-01', dryRun: true });
  assert.throws(() => options([]), error => error.code === 'IMPORT_DATE_REQUIRED');
  assert.throws(() => options(['--all']), error => error.code === 'IMPORT_OPTION_INVALID');
  assert.throws(() => options(['--date', '2023-05-01', '--date', '2023-05-02']), error => error.code === 'IMPORT_OPTION_INVALID');
  assert.throws(() => options(['--date', '2023-02-30']));
});
