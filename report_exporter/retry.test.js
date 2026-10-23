'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withRetries } = require('./retry');
const { ExporterError, describeError, responseDetails } = require('./errors');

test('transient failures recover with bounded exponential backoff', async () => {
  const attempts = [];
  const recoveries = [];
  const delays = [];
  const result = await withRetries(async attempt => {
    attempts.push(attempt);
    if (attempt < 3) throw new ExporterError('REPORT_HTTP_ERROR', { status: 503 });
    return 'completed';
  }, {
    attempts: 3,
    onRetry: async (_, retry) => recoveries.push(retry.nextAttempt),
    wait: async delay => delays.push(delay)
  });
  assert.equal(result, 'completed');
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(recoveries, [2, 3]);
  assert.deepEqual(delays, [5000, 10000]);
});

test('exhausted failures propagate rather than skipping a failed date', async () => {
  let attempts = 0;
  await assert.rejects(withRetries(async () => {
    attempts++;
    throw new ExporterError('REPORT_HTTP_ERROR', { status: 429 });
  }, { attempts: 3, wait: async () => {} }), error => error.code === 'REPORT_HTTP_ERROR');
  assert.equal(attempts, 3);
});

test('invalid local workbooks and cancellation do not retry', async () => {
  let attempts = 0;
  await assert.rejects(withRetries(async () => {
    attempts++;
    throw new ExporterError('EXISTING_WORKBOOK_INVALID', {}, { retryable: false });
  }, { attempts: 3 }), error => error.code === 'EXISTING_WORKBOOK_INVALID');
  assert.equal(attempts, 1);
  const abort = new AbortController();
  await assert.rejects(withRetries(async () => {
    abort.abort();
    throw new Error('Stopped');
  }, { attempts: 3, signal: abort.signal, onRetry: async () => assert.fail('Must not retry after cancellation') }));
});

test('diagnostics omit raw error messages and response strings', () => {
  const secret = 'mock-sensitive-value';
  assert.equal(describeError(new Error(secret)), 'UNEXPECTED_ERROR');
  assert.equal(describeError(Object.assign(new Error(secret), { name: 'TimeoutError' })), 'PLAYWRIGHT_TIMEOUT');
  const summary = responseDetails({ success: false, failCode: secret, message: secret, data: { total: secret, list: [] } });
  assert.deepEqual(summary, { success: false, failCode: null, total: null, rows: 0 });
  assert.ok(!JSON.stringify(summary).includes(secret));
});
