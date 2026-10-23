'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { convertToCsv } = require('./convert-csv');
const { reportPanel } = require('./report-ui');
const { ExporterError } = require('./errors');
const { validateCsv } = require('./validate-csv');
const { runStep } = require('./steps');

function destinationFor(date, root) {
  if (date.length === 7) return path.join(root, 'daily', date.slice(0, 4), date + '.csv');
  return path.join(root, date.slice(0, 4), date.slice(5, 7), date + '.csv');
}

async function removeIfPresent(filename) {
  try { await fs.unlink(filename); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
}

async function useExisting(date, { root = path.join(__dirname, 'exports', '134568461') } = {}) {
  const destination = destinationFor(date, root);
  const legacyXlsx = destination.slice(0, -4) + '.xlsx';
  let csvExists = false;
  try { await fs.access(destination); csvExists = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (csvExists) {
    try { await validateCsv(destination, date); }
    catch { throw new ExporterError('EXISTING_CSV_INVALID', {}, { retryable: false }); }
    // Older runs kept the workbook. A validated CSV makes it redundant.
    try {
      await removeIfPresent(legacyXlsx);
      await removeIfPresent(destination.slice(0, -4) + '.partial.xlsx');
    } catch { throw new ExporterError('XLSX_CLEANUP_FAILED', {}, { retryable: false }); }
  } else {
    try { await fs.access(legacyXlsx); }
    catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    // Migrate old downloads without querying FusionSolar. Conversion validates
    // and publishes the CSV before deleting the legacy workbook.
    try { await convertToCsv(legacyXlsx, date); }
    catch { throw new ExporterError('EXISTING_WORKBOOK_INVALID', {}, { retryable: false }); }
  }
  return true;
}

async function downloadDay(session, date, expectedRows, timeoutMs) {
  const destination = destinationFor(date, path.join(__dirname, 'exports', '134568461'));
  const panel = reportPanel(session);
  await runStep(session, 'creating the export task',
    () => panel.getByRole('button', { name: 'Export', exact: true }).click(), { timeoutMs: session.actionTimeoutMs });
  const tasks = session.report.getByRole('dialog', { name: 'Tasks', exact: true });
  const taskDate = date.split('-').reverse().join('-');
  const task = tasks.locator('.row-body').filter({ hasText: new RegExp('Plant Report_.*_' + taskDate) }).first();
  const icon = task.getByRole('img', { name: 'download', exact: true });
  await runStep(session, 'waiting for the export task', async () => {
    await tasks.waitFor({ timeout: session.stepTimeoutMs });
    await icon.waitFor({ timeout: session.stepTimeoutMs });
  });
  const [download] = await runStep(session, 'starting the download', () => Promise.all([
    session.page.waitForEvent('download', { timeout: session.stepTimeoutMs }),
    icon.click()
  ]));
  // saveAs() waits for the file transfer, which has no built-in timeout.
  const temporary = destination.slice(0, -4) + '.partial.xlsx';
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await runStep(session, 'saving the download', () => download.saveAs(temporary), { timeoutMs });
  if (await download.failure() || !download.suggestedFilename().toLowerCase().endsWith('.xlsx')) {
    throw new ExporterError('DOWNLOAD_INVALID');
  }
  session.step = 'validating and converting the workbook';
  try { await convertToCsv(temporary, date, { csvPath: destination, expectedRows }); }
  catch { throw new ExporterError('DOWNLOADED_WORKBOOK_INVALID'); }
  session.step = 'closing the Tasks panel';
  await tasks.getByRole('button', { name: 'Close', exact: true }).click();
}

module.exports = { useExisting, downloadDay };
