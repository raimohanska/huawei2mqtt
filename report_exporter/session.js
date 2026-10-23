'use strict';

const path = require('node:path');
const { chromium } = require('playwright');
const { loadConfig } = require('./config');
const { ExporterError, describeError } = require('./errors');
const { log } = require('./logger');

const REPORT_URL = 'https://uni002eu5.fusionsolar.huawei.com/uniportal/pvmswebsite/assets/build/cloud.html?app-id=smartpvms&instance-id=smartpvms&zone-id=region-2-62bcb766-e57d-4886-921d-a59df938d941#/reportv3/site/NE=134568461';

function redact(text, config) {
  for (const value of Object.values(config)) {
    text = text.split(value).join('[redacted]');
    text = text.split(JSON.stringify(value).slice(1, -1)).join('[redacted]');
  }
  return text;
}

async function openReport({ headed = false, timeoutMs = 15 * 60 * 1000, actionTimeoutMs = 30000, stepTimeoutMs = 120000, onContext = () => {} } = {}) {
  let config;
  try { config = loadConfig(); }
  catch { throw new ExporterError('CONFIGURATION_INVALID', {}, { retryable: false }); }
  let context;
  let step = 'launching browser';
  try {
    context = await chromium.launchPersistentContext(path.join(__dirname, '.playwright/profile'), {
      headless: !headed,
      timeout: stepTimeoutMs,
      acceptDownloads: true,
      viewport: { width: 1920, height: 1080 }
    });
    onContext(context);
    context.setDefaultTimeout(actionTimeoutMs);
    context.setDefaultNavigationTimeout(stepTimeoutMs);
    const page = context.pages()[0] || await context.newPage();
    step = 'opening login';
    log.info('Opening FusionSolar login.');
    await page.goto(config.loginPage, { waitUntil: 'domcontentloaded' });
    // The login form can take a moment to mount; a saved session may instead
    // redirect straight into the application.
    await Promise.race([
      page.locator('#username').waitFor({ state: 'visible', timeout: stepTimeoutMs }),
      page.waitForURL(url => url.pathname.includes('/pvmswebsite/'), { timeout: stepTimeoutMs })
    ]);
    if (await page.locator('#username').isVisible()) {
      step = 'filling login';
      await page.locator('#username').fill(config.username);
      await page.locator('#value').fill(config.password);
      step = 'submitting login';
      await page.locator('#submitDataverify').click();
      log.info('Waiting for authenticated application.');
      step = 'waiting for authentication';
      await page.locator('#username').waitFor({ state: 'hidden', timeout: stepTimeoutMs });
      await page.waitForURL(url => url.pathname.includes('/pvmswebsite/'), { timeout: stepTimeoutMs });
    }
    log.info('Opening Plant Report.');
    step = 'opening report';
    // Wait for the initial plant redirect to finish before selecting a route;
    // navigating earlier lets startup overwrite the requested report page.
    await page.getByText('Grid connection date', { exact: true }).waitFor({ timeout: stepTimeoutMs });
    await page.evaluate(hash => { window.location.hash = hash; }, new URL(REPORT_URL).hash);
    let report;
    const deadline = Date.now() + stepTimeoutMs;
    while (!report && Date.now() < deadline) {
      for (const frame of page.frames()) {
        if (await frame.getByText('Statistical period', { exact: true }).first().isVisible().catch(() => false)) {
          report = frame;
          break;
        }
      }
      if (!report) await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!report) throw new Error('Plant Report did not appear.');
    return { context, page, report, timeoutMs, actionTimeoutMs, stepTimeoutMs, redact: text => redact(text, config) };
  } catch (error) {
    if (context) await context.close().catch(() => {});
    throw new ExporterError('SESSION_OPEN_FAILED', { step, category: describeError(error) });
  }
}

module.exports = { openReport };
