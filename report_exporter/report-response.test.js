'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { chromium } = require('playwright');
const { captureReportResponse, matchesDate } = require('./report-response');

test('capture ignores wrong dates and malformed/non-daily requests', () => {
  const request = payload => ({ postDataJSON: () => payload });
  assert.equal(matchesDate(request({ statDim: 2, statTime: Date.parse('2026-10-11T21:00:00Z') }), '2026-10-12'), true);
  assert.equal(matchesDate(request({ statDim: 2, statTime: Date.parse('2026-10-11T21:00:00Z') }), '2026-10-11'), false);
  assert.equal(matchesDate(request({ statDim: 3, statTime: 0 }), '2026-10-12'), false);
  assert.equal(matchesDate(request(null), '2026-10-12'), false);
});

test('report capture works across a browser download, without duplicate queries, and detects HTTP failures', { timeout: 30000 }, async () => {
  let queries = 0;
  let fail = false;
  const server = http.createServer((request, response) => {
    if (request.url === '/download') {
      response.writeHead(200, { 'Content-Disposition': 'attachment; filename=sample.txt' });
      response.end('sample');
    } else if (request.url.endsWith('/station-kpi-list')) {
      request.resume();
      request.on('end', () => {
        queries++;
        response.writeHead(fail ? 503 : 200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ success: !fail, failCode: fail ? 503 : 0, data: { total: 1, list: [{ yield: queries }] } }));
      });
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<a href="/download">Download</a>');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ acceptDownloads: true });
    await page.goto('http://127.0.0.1:' + server.address().port);
    const fetchReport = timestamp => page.evaluate(async statTime => {
      const response = await fetch('/rest/pvms/web/report/v1/station/station-kpi-list', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ statDim: 2, statTime })
      });
      const json = await response.json();
      document.body.dataset.rows = String(json.data.total);
    }, timestamp);
    const first = await captureReportResponse(page, '2026-10-12', 10000,
      () => fetchReport(Date.parse('2026-10-11T21:00:00Z')));
    assert.equal(first.data.list[0].yield, 1);
    assert.equal(queries, 1);
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download' }).click()]);
    await download.delete();
    const second = await captureReportResponse(page, '2026-10-11', 10000,
      () => fetchReport(Date.parse('2026-10-10T21:00:00Z')));
    assert.equal(second.data.list[0].yield, 2);
    assert.equal(queries, 2);
    assert.equal(await page.locator('body').getAttribute('data-rows'), '1');
    fail = true;
    await assert.rejects(captureReportResponse(page, '2026-10-10', 10000,
      () => fetchReport(Date.parse('2026-10-09T21:00:00Z'))),
    error => error.code === 'REPORT_HTTP_ERROR' && error.details.status === 503);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
