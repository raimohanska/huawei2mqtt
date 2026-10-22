'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { options } = require('./export-reports');
const { validateDate, previousDate, plantDate } = require('./dates');
const { validateReportResponse } = require('./report-ui');

test('inclusive bounds, limits, and long timeouts parse without starting a browser', () => {
  const config = options(['--from', '2024-02-29', '--to', '2024-03-01', '--max-days', '2', '--timeout-minutes', '30']);
  assert.equal(config.from, '2024-02-29');
  assert.equal(config.to, '2024-03-01');
  assert.equal(config.maxDays, 2);
  assert.equal(config.timeoutMs, 1800000);
  assert.equal(options([]).timeoutMs, 900000);
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
