'use strict';

const ExcelJS = require('exceljs');
const { validateDate } = require('./dates');

async function validateCsv(csvPath, expectedDate) {
  const workbook = new ExcelJS.Workbook();
  // Use the CSV reader already provided by ExcelJS, preserving timestamp text
  // and blank/zero values rather than interpreting them as dates or numbers.
  const sheet = await workbook.csv.readFile(csvPath, { map: value => value });
  const headers = sheet.getRow(1).values.slice(1);
  const required = ['Statistical Period', 'PV Yield (kWh)', 'Inverter Yield (kWh)'];
  if (headers[0] !== required[0] || required.some(name => !headers.includes(name)) ||
      headers.some(header => !header) || new Set(headers).size !== headers.length) {
    throw new Error('CSV does not contain the expected plant report headers.');
  }
  const rows = sheet.rowCount - 1;
  if (rows < 1 || rows > 25) throw new Error('CSV must contain 1–25 hourly rows.');
  const date = expectedDate || sheet.getRow(2).getCell(1).text.slice(0, 10);
  validateDate(date);
  const timestamp = new RegExp('^' + date + ' (?:[01]\\d|2[0-3]):00:00(?: (?:DST|ST))?$');
  for (let index = 2; index <= sheet.rowCount; index++) {
    const row = sheet.getRow(index);
    if (row.cellCount !== headers.length || !timestamp.test(row.getCell(1).text)) {
      throw new Error('CSV rows do not match the expected date or column count.');
    }
    for (const name of required.slice(1)) {
      const value = row.getCell(headers.indexOf(name) + 1).text;
      if (value !== '' && (!/^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value)))) {
        throw new Error('CSV contains an invalid yield reading.');
      }
    }
  }
  return { csvPath, rows, columns: headers.length };
}

module.exports = { validateCsv };
