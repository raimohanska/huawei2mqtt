'use strict';

const { plantDate } = require('./dates');
const { ExporterError, describeError } = require('./errors');

const REPORT_PATTERN = '**/rest/pvms/web/report/v1/station/station-kpi-list';

function matchesDate(request, date) {
  try {
    const body = request.postDataJSON();
    return Number(body.statDim) === 2 && plantDate(body.statTime) === date;
  } catch { return false; }
}

async function captureReportResponse(page, date, timeoutMs, trigger) {
  let resolveResponse;
  let rejectResponse;
  let timer;
  const captured = new Promise((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const handler = async route => {
    if (!matchesDate(route.request(), date)) { await route.continue().catch(() => {}); return; }
    try {
      // Chromium can lose the CDP response-body resource after a file download
      // (reproduced on the next daily query). Buffer the response through
      // Playwright's route API instead, then deliver the same bytes to the UI.
      // The request is still initiated by Search; no extra report request is made.
      const response = await route.fetch({ timeout: timeoutMs, maxRetries: 1 });
      const body = await response.body();
      await route.fulfill({ response, body });
      resolveResponse({ status: response.status(), body });
      await response.dispose().catch(() => {});
    } catch (error) {
      rejectResponse(new ExporterError('REPORT_CAPTURE_FAILED', { category: describeError(error) }));
      await route.abort().catch(() => {});
    }
  };
  await page.route(REPORT_PATTERN, handler);
  try {
    timer = setTimeout(() => rejectResponse(new ExporterError('REPORT_REQUEST_TIMEOUT')), timeoutMs);
    const [response] = await Promise.all([captured, trigger()]);
    if (response.status < 200 || response.status >= 300) {
      throw new ExporterError('REPORT_HTTP_ERROR', { status: response.status });
    }
    try { return JSON.parse(response.body.toString('utf8')); }
    catch {
      throw new ExporterError('REPORT_BODY_NOT_JSON', { status: response.status, bytes: response.body.length });
    }
  } finally {
    clearTimeout(timer);
    await page.unroute(REPORT_PATTERN, handler).catch(() => {});
  }
}

module.exports = { captureReportResponse, matchesDate };
