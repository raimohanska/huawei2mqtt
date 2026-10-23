'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { options, run } = require('./export-reports');
const { validateDate, previousDate, plantDate, validateMonth, previousMonth, daysInMonth } = require('./dates');
const { validateReportResponse } = require('./report-ui');
const { matchesDate } = require('./report-response');

test('inclusive bounds, limits, and long timeouts parse without starting a browser', () => {
  const config = options(['--from', '2024-02-29', '--to', '2024-03-01', '--max-days', '2', '--timeout-minutes', '30']);
  assert.equal(config.from, '2024-02-29');
  assert.equal(config.to, '2024-03-01');
  assert.equal(config.maxDays, 2);
  assert.equal(config.timeoutMs, 1800000);
  assert.equal(options([]).timeoutMs, 900000);
  assert.equal(options([]).actionTimeoutMs, 30000);
  assert.equal(options([]).stepTimeoutMs, 120000);
  const deadlines = options(['--action-timeout-seconds', '10', '--step-timeout-seconds', '90', '--timeout-minutes', '30']);
  assert.equal(deadlines.actionTimeoutMs, 10000);
  assert.equal(deadlines.stepTimeoutMs, 90000);
  assert.equal(deadlines.timeoutMs, 1800000);
  assert.throws(() => options(['--action-timeout-seconds', '0']));
  assert.throws(() => options(['--step-timeout-seconds', 'NaN']));
  assert.equal(options([]).attempts, 3);
  assert.equal(options(['--attempts', '5']).attempts, 5);
  assert.throws(() => options(['--attempts', '0']));
  assert.throws(() => options(['--attempts', '11']));
  assert.throws(() => options(['--from', '2024-03-02', '--to', '2024-03-01']));
  assert.throws(() => options(['--today', '--from', '2024-03-01']));
  assert.throws(() => options(['--max-days', '0']));
  assert.throws(() => options(['--timeout-minutes', 'NaN']));
  assert.equal(options(['--monthly-only', '--max-months', '2']).maxMonths, 2);
  assert.equal(options(['--today']).hourlyOnly, true);
  assert.throws(() => options(['--monthly-only', '--hourly-only']));
  assert.throws(() => options(['--monthly-only', '--max-days', '2']));
  assert.throws(() => options(['--monthly-only', '--today']));
  assert.throws(() => options(['--max-months', '0']));
});

test('date traversal handles leap days and year/month/DST boundaries', () => {
  assert.equal(previousDate('2024-03-01'), '2024-02-29');
  assert.equal(previousDate('2025-03-01'), '2025-02-28');
  assert.equal(previousDate('2026-01-01'), '2025-12-31');
  assert.equal(previousDate('2026-10-26'), '2026-10-25');
  assert.equal(previousDate('2026-03-30'), '2026-03-29');
  assert.throws(() => validateDate('2025-02-29'));
  assert.throws(() => validateDate('2026-02-31'));
  assert.throws(() => validateDate('2026-2-1'));
  assert.equal(plantDate(Date.parse('2026-10-21T21:00:00Z')), '2026-10-22');
  assert.equal(plantDate(Date.parse('2026-12-21T22:00:00Z')), '2026-12-22');
});

test('the observed historical empty response is recognized but failures are rejected', () => {
  const empty = { success: false, failCode: 0, message: null, data: { total: 0, list: [] } };
  assert.deepEqual(validateReportResponse(empty), { empty: true, total: 0 });
  assert.throws(() => validateReportResponse({ ...empty, failCode: 401 }));
  assert.throws(() => validateReportResponse({ ...empty, failCode: 429 }));
  assert.throws(() => validateReportResponse({ ...empty, message: 'Service unavailable' }));
  assert.throws(() => validateReportResponse(null));
  assert.throws(() => validateReportResponse({ success: false }));
});

test('hourly placeholders, zero yields, and 25-hour DST days do not stop traversal', () => {
  const report = { success: true, failCode: 0, data: { total: 25, list: Array(25).fill({ yield: null }) } };
  assert.deepEqual(validateReportResponse(report), { empty: false, total: 25 });
  assert.deepEqual(validateReportResponse({ ...report, data: { total: 1, list: [{ yield: 0 }] } }), { empty: false, total: 1 });
  assert.throws(() => validateReportResponse({ ...report, data: { total: 25, list: Array(10).fill({}) } }));
});

test('month traversal and request matching handle year boundaries, leap years, and granularity', () => {
  assert.equal(previousMonth('2026-01'), '2025-12');
  assert.equal(previousMonth('2024-03'), '2024-02');
  assert.equal(daysInMonth('2024-02'), 29);
  assert.equal(daysInMonth('2025-02'), 28);
  assert.throws(() => validateMonth('2026-13'));
  const request = dimension => ({ postDataJSON: () => ({ statDim: dimension, statTime: 1780261200000 }) });
  assert.equal(matchesDate(request('4'), '2026-06'), true);
  assert.equal(matchesDate(request('4'), '2026-05'), false);
  assert.equal(matchesDate(request('2'), '2026-06'), false);
  assert.equal(matchesDate(request('4'), '2026-06-01'), false);
});

async function simulateRun(argv, { existing = () => false, hourly = () => true, monthly = () => true } = {}) {
  const latest = '2026-12-31';
  const queries = [];
  const months = [];
  const modes = [];
  const downloads = [];
  const lines = [];
  const original = console.log;
  console.log = line => lines.push(line);
  try {
    await run(['--to', latest, '--attempts', '1', ...argv], {
      openReport: async options => {
        const context = { close: async () => {} };
        options.onContext(context);
        return { context };
      },
      prepareReport: async (_, granularity) => modes.push(granularity),
      useExisting: async date => existing(date),
      queryDay: async (_, date) => {
        queries.push(date);
        return { empty: hourly(date), total: 24 };
      },
      queryMonth: async (_, month) => {
        months.push(month);
        return { empty: monthly(month), total: daysInMonth(month) };
      },
      downloadDay: async (_, date) => downloads.push(date)
    });
  } finally { console.log = original; }
  return { queries, months, modes, downloads, lines };
}

test('first missing hourly day switches immediately to daily-yield months, stopping on first empty month', async () => {
  const result = await simulateRun(['--max-days', '3', '--max-months', '5'], {
    monthly: month => month === '2026-10'
  });
  assert.deepEqual(result.queries, ['2026-12-31']);
  assert.deepEqual(result.months, ['2026-12', '2026-11', '2026-10']);
  assert.deepEqual(result.downloads, ['2026-12', '2026-11']);
  assert.deepEqual(result.modes, ['hourly', 'daily']);
  assert.ok(result.lines.at(-1).includes('no daily data in month 2026-10'));
});

test('resume skips hourly and monthly CSVs independently and starts months at the newest requested month', async () => {
  const existing = new Set(['2026-12-31', '2026-12-30', '2026-12']);
  const result = await simulateRun(['--max-days', '5', '--max-months', '5'], {
    existing: period => existing.has(period), monthly: month => month === '2026-10'
  });
  assert.deepEqual(result.queries, ['2026-12-29']);
  assert.deepEqual(result.months, ['2026-11', '2026-10']);
  assert.deepEqual(result.downloads, ['2026-11']);
  assert.ok(result.lines.some(line => line.includes('Skipping to 2026-12-29 because 2 days')));
  assert.ok(result.lines.some(line => line.includes('Skipping to 2026-11 because 1 month')));
});

test('hourly date bounds and max-days do not start an unbounded monthly loop', async () => {
  const bounded = await simulateRun(['--from', '2026-12-29'], { hourly: () => false });
  assert.equal(bounded.queries.length, 3);
  assert.deepEqual(bounded.months, []);
  assert.ok(bounded.lines.at(-1).includes('date range completed'));
  const limited = await simulateRun(['--max-days', '2'], { hourly: () => false });
  assert.equal(limited.queries.length, 2);
  assert.deepEqual(limited.months, []);
  assert.ok(limited.lines.at(-1).includes('max-days limit reached'));
});

test('monthly-only respects month bounds and max-months without querying hourly data', async () => {
  const bounded = await simulateRun(['--monthly-only', '--from', '2026-11-15'], { monthly: () => false });
  assert.deepEqual(bounded.queries, []);
  assert.deepEqual(bounded.months, ['2026-12', '2026-11']);
  assert.deepEqual(bounded.modes, ['daily']);
  assert.ok(bounded.lines.at(-1).includes('monthly date range completed'));
  const limited = await simulateRun(['--monthly-only', '--max-months', '2'], { monthly: () => false });
  assert.deepEqual(limited.months, ['2026-12', '2026-11']);
  assert.ok(limited.lines.at(-1).includes('max-months limit reached'));
});

test('an all-existing monthly range avoids opening the browser and hourly-only disables fallback', async () => {
  const skipped = await simulateRun(['--monthly-only', '--max-months', '2'], { existing: () => true });
  assert.deepEqual(skipped.queries, []);
  assert.deepEqual(skipped.months, []);
  assert.deepEqual(skipped.modes, []);
  assert.ok(skipped.lines.at(-1).includes('skipped=2'));
  const hourly = await simulateRun(['--hourly-only', '--max-days', '2']);
  assert.deepEqual(hourly.queries, ['2026-12-31']);
  assert.deepEqual(hourly.months, []);
});
