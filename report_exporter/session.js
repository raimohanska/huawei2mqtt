'use strict';

const path = require('node:path');
const { chromium } = require('playwright');
const { loadConfig } = require('./config');

const REPORT_URL = 'https://uni002eu5.fusionsolar.huawei.com/uniportal/pvmswebsite/assets/build/cloud.html?app-id=smartpvms&instance-id=smartpvms&zone-id=region-2-62bcb766-e57d-4886-921d-a59df938d941#/reportv3/site/NE=134568461';

function redact(text, config) {
  for (const value of Object.values(config)) {
    text = text.split(value).join('[redacted]');
    text = text.split(JSON.stringify(value).slice(1, -1)).join('[redacted]');
  }
  return text;
}

async function openReport({ headed = false } = {}) {
  const config = loadConfig();
  const context = await chromium.launchPersistentContext(path.join(__dirname, '.playwright/profile'), {
    headless: !headed,
    acceptDownloads: true,
    viewport: { width: 1920, height: 1080 }
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(30000);
    console.log('Opening FusionSolar login.');
    await page.goto(config.loginPage, { waitUntil: 'domcontentloaded' });
    // The login form can take a moment to mount; a saved session may instead
    // redirect straight into the application.
    await Promise.race([
      page.locator('#username').waitFor({ state: 'visible', timeout: 60000 }),
      page.waitForURL(url => url.pathname.includes('/pvmswebsite/'), { timeout: 60000 })
    ]);
    if (await page.locator('#username').isVisible()) {
      console.log('Filling login form.');
      await page.locator('#username').fill(config.username);
      await page.locator('#value').fill(config.password);
      console.log('Submitting login form.');
      await page.locator('#submitDataverify').click();
      console.log('Waiting for authenticated application.');
      await page.locator('#username').waitFor({ state: 'hidden', timeout: 60000 });
      await page.waitForURL(url => url.pathname.includes('/pvmswebsite/'), { timeout: 60000 });
    }
    console.log('Opening Plant Report.');
    // Wait for the initial plant redirect to finish before selecting a route;
    // navigating earlier lets startup overwrite the requested report page.
    await page.getByText('Grid connection date', { exact: true }).waitFor({ timeout: 60000 });
    await page.evaluate(hash => { window.location.hash = hash; }, new URL(REPORT_URL).hash);
    let report;
    const deadline = Date.now() + 60000;
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
    return { context, page, report, redact: text => redact(text, config) };
  } catch {
    await context.close();
    throw new Error('Could not open the plant report. Check login or complete any verification in headed mode.');
  }
}

module.exports = { openReport };
