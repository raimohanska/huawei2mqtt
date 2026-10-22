'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { convertToCsv, logConversion } = require('./convert-csv');
const { reportPanel } = require('./report-ui');

function destinationFor(date) {
  return path.join(__dirname, 'exports', '134568461', date.slice(0, 4), date.slice(5, 7), date + '.xlsx');
}

async function useExisting(date) {
  const destination = destinationFor(date);
  try { await fs.access(destination); }
  catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  // Parsing and date validation prevent a corrupt/wrong-day XLSX being skipped.
  // Regenerate CSV locally even when it was missing after an interrupted run.
  logConversion(await convertToCsv(destination, date));
  console.log('Skipped download: ' + date + ' (existing workbook validated)');
  return true;
}

async function downloadDay(session, date, expectedRows, timeoutMs) {
  const destination = destinationFor(date);
  const panel = reportPanel(session);
  await panel.getByRole('button', { name: 'Export', exact: true }).click();
  const tasks = session.report.getByRole('dialog', { name: 'Tasks', exact: true });
  await tasks.waitFor();
  const taskDate = date.split('-').reverse().join('-');
  const task = tasks.locator('.row-body').filter({ hasText: new RegExp('Plant Report_.*_' + taskDate) }).first();
  const icon = task.getByRole('img', { name: 'download', exact: true });
  await icon.waitFor();
  const [download] = await Promise.all([
    session.page.waitForEvent('download'),
    icon.click()
  ]);
  // saveAs() waits for the file transfer, which has no built-in timeout.
  let timer;
  const temporary = destination.slice(0, -5) + '.partial.xlsx';
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await Promise.race([
      download.saveAs(temporary),
      new Promise((_, reject) => {
        timer = setTimeout(() => { download.cancel().catch(() => {}); reject(new Error('Download transfer timed out.')); }, timeoutMs);
      })
    ]);
  } finally { clearTimeout(timer); }
  if (await download.failure() || !download.suggestedFilename().toLowerCase().endsWith('.xlsx')) {
    throw new Error('Expected a completed XLSX download.');
  }
  const converted = await convertToCsv(temporary, date);
  if (converted.rows !== expectedRows) throw new Error('Downloaded hourly rows do not match the report.');
  await fs.rename(temporary, destination);
  const csvPath = destination.slice(0, -5) + '.csv';
  await fs.rename(converted.csvPath, csvPath);
  console.log('Downloaded: ' + path.relative(__dirname, destination));
  logConversion({ ...converted, csvPath });
  await tasks.getByRole('button', { name: 'Close', exact: true }).click();
}

module.exports = { useExisting, downloadDay };
