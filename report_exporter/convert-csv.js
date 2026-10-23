'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { validateCsv } = require('./validate-csv');
const { log } = require('./logger');

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

async function convertToCsv(xlsxPath, expectedDate, { csvPath = xlsxPath.slice(0, -5) + '.csv', expectedRows } = {}) {
  if (!xlsxPath.toLowerCase().endsWith('.xlsx')) throw new Error('Expected an XLSX file.');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(xlsxPath);
  const reports = workbook.worksheets.map(sheet => {
    const data = [];
    sheet.eachRow(row => {
      data.push(Array.from({ length: sheet.columnCount }, (_, index) => row.getCell(index + 1).text));
    });
    return {
      data,
      headerIndex: data.findIndex(row =>
        String(row[0] || '').trim() === 'Statistical Period' &&
        row.some(cell => String(cell || '').trim() === 'PV Yield (kWh)'))
    };
  }).filter(sheet => sheet.headerIndex >= 0);
  if (reports.length !== 1) throw new Error('Expected exactly one plant report table.');

  const { data, headerIndex } = reports[0];
  const headers = data[headerIndex].map(cell => String(cell === null ? '' : cell).trim());
  const rows = data.slice(headerIndex + 1).filter(row => row.some(cell => cell !== null && cell !== ''));
  if (rows.length === 0) throw new Error('The plant report contains no hourly rows.');
  for (const row of rows) {
    if (typeof row[0] !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(row[0]) ||
        (expectedDate && !row[0].startsWith(expectedDate + ' ')) || row.length > headers.length) {
      throw new Error('The workbook does not match the expected daily report.');
    }
  }
  // Omit the decorative title row, retain every report column, and pad blanks.
  const csv = [headers, ...rows].map(row =>
    headers.map((_, index) => csvCell(row[index])).join(',')).join('\r\n') + '\r\n';
  const temporary = csvPath + '.partial';
  await fs.writeFile(temporary, csv, 'utf8');
  const validated = await validateCsv(temporary, expectedDate);
  if (expectedRows !== undefined && validated.rows !== expectedRows) {
    throw new Error('Converted hourly rows do not match the report.');
  }
  await fs.rename(temporary, csvPath);
  // Publish and validate the complete CSV before removing the source. Failed
  // conversions keep the XLSX, and partial CSVs never act as completion markers.
  await fs.unlink(xlsxPath);
  return { csvPath, rows: rows.length, columns: headers.length };
}

function logConversion(result) {
  log.info('Converted: ' + path.relative(__dirname, result.csvPath) +
    ' (' + result.rows + ' hourly rows, ' + result.columns + ' columns)');
}

if (require.main === module) {
  const filename = process.argv[2];
  if (!filename || process.argv.length !== 3) {
    log.error('Usage: npm run convert:csv -- path/to/report.xlsx');
    process.exitCode = 1;
  } else {
    const date = path.basename(filename, '.xlsx');
    convertToCsv(path.resolve(filename), /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined)
      .then(logConversion)
      .catch(() => {
        log.error('CSV conversion failed. Check that the XLSX contains a daily plant report.');
        process.exitCode = 1;
      });
  }
}

module.exports = { convertToCsv, logConversion };
