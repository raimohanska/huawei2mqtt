'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: sleep } = require('node:timers/promises');
const { runStep } = require('./steps');
const { withRetries } = require('./retry');

test('completed steps clear their deadline without closing the browser', async () => {
  let closes = 0;
  const session = { stepTimeoutMs: 10, context: { close: async () => { closes++; } } };
  assert.equal(await runStep(session, 'test operation', async () => 'done'), 'done');
  await sleep(20);
  assert.equal(closes, 0);
});

test('a stalled step closes its browser and recovery finishes on a fresh attempt', async () => {
  const sessions = [];
  const attempts = [];
  const result = await withRetries(async attempt => {
    attempts.push(attempt);
    let cancel;
    const session = { stepTimeoutMs: 15, closed: false, context: { close: async () => {
      session.closed = true;
      if (cancel) cancel(new Error('Browser closed'));
    } } };
    sessions.push(session);
    return runStep(session, 'waiting for the export task', () => attempt === 1 ?
      new Promise((_, reject) => { cancel = reject; }) : Promise.resolve('exported'));
  }, {
    attempts: 3,
    onRetry: async error => {
      assert.equal(error.code, 'STEP_TIMEOUT');
      assert.equal(error.details.step, 'waiting for the export task');
      assert.equal(sessions[0].closed, true);
    },
    wait: async () => {}
  });
  assert.equal(result, 'exported');
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(sessions[0].closed, true);
  assert.equal(sessions[1].closed, false);
});

test('step timeout overrides distinguish short actions from long file transfers', async () => {
  let closes = 0;
  const session = { stepTimeoutMs: 1000, context: { close: async () => { closes++; } } };
  await assert.rejects(runStep(session, 'clicking export', () => new Promise(() => {}), { timeoutMs: 10 }),
    error => error.code === 'STEP_TIMEOUT' && error.details.timeoutSeconds === 0.01);
  assert.equal(closes, 1);
});

test('long waits report their step with a timestamp and stop reporting after completion', async () => {
  const lines = [];
  const original = console.warn;
  console.warn = line => lines.push(line);
  try {
    const session = { date: '2026-02-15', stepTimeoutMs: 200, context: { close: async () => {} } };
    await runStep(session, 'waiting for the export task', () => sleep(35), { progressMs: 10 });
    assert.ok(lines.length > 0);
    const count = lines.length;
    await sleep(20);
    assert.equal(lines.length, count);
  } finally { console.warn = original; }
  assert.ok(lines.every(line => /T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2} \[WARN\] Step: waiting for the export task \(2026-02-15\)/.test(line)));
});
