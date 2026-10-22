'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { openReport } = require('./session');
const { convertToCsv, logConversion } = require('./convert-csv');

async function main() {
  const session = await openReport({ headed: process.argv.includes('--headed') });
  let stage = 'selecting daily report';
  try {
    const { page, report } = session;
    const panel = report.getByRole('tabpanel', { name: 'Plant Report', exact: true });
    await report.getByRole('tab', { name: 'Plant Report', exact: true }).click();
    // The selected value is rendered separately from the readonly combobox.
    if (!await panel.getByText('By day', { exact: true }).isVisible()) {
      await panel.getByRole('combobox', { name: 'Time granularity', exact: true }).locator('xpath=../../..').click();
      await report.getByText('By day', { exact: true }).last().click();
    }

    stage = 'selecting 100 rows per page';
    console.log('Selecting 100 rows per page.');
    await panel.getByRole('combobox', { name: 'Page Size', exact: true }).locator('xpath=../../..').click();
    await report.getByText('100 / page', { exact: true }).last().click();

    stage = 'selecting today';
    console.log('Selecting today in the report calendar.');
    const dateInput = panel.getByRole('textbox', { name: 'Statistical period', exact: true });
    await dateInput.click();
    await report.getByText('Today', { exact: true }).click();
    const date = await dateInput.inputValue();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Unexpected report date.');

    const destination = path.join(__dirname, 'exports', '134568461', date.slice(0, 4), date.slice(5, 7), date + '.xlsx');
    // Skip only completed files; temporary downloads never use the final name.
    let existing;
    try {
      existing = await fs.readFile(destination);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (existing) {
      if (existing.length <= 4 || !existing.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
        throw new Error('Existing file is not an XLSX archive; inspect it before retrying.');
      }
      console.log('Already downloaded: ' + path.relative(__dirname, destination));
      stage = 'converting the existing workbook to CSV';
      logConversion(await convertToCsv(destination, date));
      return;
    }

    stage = 'searching for the selected day';
    console.log('Loading hourly rows for ' + date + '.');
    await panel.getByRole('button', { name: 'Search', exact: true }).click();
    await panel.getByRole('cell', { name: new RegExp('^' + date + ' 00:00:00') }).waitFor();
    await panel.locator('[class*="spin-spinning"]').waitFor({ state: 'hidden' });

    stage = 'exporting the report';
    console.log('Exporting ' + date + '.');
    await panel.getByRole('button', { name: 'Export', exact: true }).click();
    const tasks = report.getByRole('dialog', { name: 'Tasks', exact: true });
    await tasks.waitFor();
    const taskDate = date.split('-').reverse().join('-');
    const task = tasks.locator('.row-body').filter({ hasText: new RegExp('Plant Report_.*_' + taskDate) }).first();
    const downloadIcon = task.getByRole('img', { name: 'download', exact: true });
    await downloadIcon.waitFor({ timeout: 120000 });
    stage = 'downloading the completed task';
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 120000 }),
      downloadIcon.click()
    ]);
    if (await download.failure()) throw new Error('Download did not complete.');
    if (!download.suggestedFilename().toLowerCase().endsWith('.xlsx')) {
      throw new Error('Expected an XLSX download.');
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const temporary = destination + '.partial';
    await download.saveAs(temporary);
    const contents = await fs.readFile(temporary);
    if (contents.length < 4 || !contents.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
      throw new Error('Downloaded file is not an XLSX archive.');
    }
    await fs.rename(temporary, destination);
    console.log('Downloaded: ' + path.relative(__dirname, destination) + ' (' + contents.length + ' bytes)');
    stage = 'converting the downloaded workbook to CSV';
    logConversion(await convertToCsv(destination, date));
  } catch {
    // Do not print raw Playwright errors: they can contain form values or URLs.
    console.error('Export failed while ' + stage + '.');
    console.log(session.redact(await session.report.getByRole('tabpanel', { name: 'Plant Report', exact: true }).ariaSnapshot().catch(() => 'Report panel unavailable.')));
    throw new Error('Export failed.');
  } finally {
    await session.context.close();
  }
}

main().catch(() => {
  console.error('Report export/conversion did not complete.');
  process.exitCode = 1;
});
