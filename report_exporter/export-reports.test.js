'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { options, run } = require('./export-reports');
const { validateDate, previousDate, plantDate } = require('./dates');
const { validateReportResponse } = require('./report-ui');

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

async function simulateRun(argv, { existingIndex = -1, availableIndex = -1 } = {}) {
  const latest = '2026-12-31';
  const indexOf = date => (Date.parse(latest + 'T00:00:00Z') - Date.parse(date + 'T00:00:00Z')) / 86400000;
  const queries = [];
  const downloads = [];
  const lines = [];
  const original = console.log;
  console.log = line => lines.push(line);
  try {
    await run(['--to', latest, ...argv], {
      openReport: async options => {
        const context = { close: async () => {} };
        options.onContext(context);
        return { context };
      },
      prepareReport: async () => {},
      useExisting: async date => indexOf(date) === existingIndex,
      queryDay: async (_, date) => {
        queries.push(date);
        return { empty: indexOf(date) !== availableIndex, total: 24 };
      },
      downloadDay: async (_, date) => downloads.push(date)
    });
  } finally { console.log = original; }
  return { queries, downloads, lines };
}

test('the real traversal stops on the 30th confirmed empty day, not the first or 31st', async () => {
  const result = await simulateRun(['--max-days', '31']);
  assert.equal(result.queries.length, 30);
  assert.equal(result.queries[29], '2026-12-02');
  assert.deepEqual(result.downloads, []);
  assert.ok(result.lines.at(-1).includes('30 consecutive no-data days ending 2026-12-02'));
  assert.ok(result.lines.at(-1).includes('Visited=30, downloaded=0, skipped=0, empty=30'));
});

test('both existing CSVs and newly exported days reset consecutive no-data history', async () => {
  // 20 empty days, one existing CSV, 20 empty days, one new report, then 30 empty.
  const result = await simulateRun(['--max-days', '100'], { existingIndex: 20, availableIndex: 41 });
  assert.equal(result.queries.length, 71);
  assert.deepEqual(result.downloads, ['2026-11-20']);
  assert.equal(result.queries.at(-1), '2026-10-21');
  assert.ok(result.lines.at(-1).includes('30 consecutive no-data days ending 2026-10-21'));
  assert.ok(result.lines.at(-1).includes('Visited=72, downloaded=1, skipped=1, empty=70'));
});

test('explicit date bounds and max-days still finish before 30 empty days', async () => {
  const bounded = await simulateRun(['--from', '2026-12-29']);
  assert.equal(bounded.queries.length, 3);
  assert.ok(bounded.lines.at(-1).includes('date range completed'));
  const limited = await simulateRun(['--max-days', '2']);
  assert.equal(limited.queries.length, 2);
  assert.ok(limited.lines.at(-1).includes('max-days limit reached'));
});
