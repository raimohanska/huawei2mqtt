'use strict';

const ExcelJS = require('exceljs');
const { validateDate, validateMonth, daysInMonth } = require('./dates');

async function validateCsv(csvPath, expectedPeriod) {
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
  const first = sheet.getRow(2).getCell(1).text;
  const daily = expectedPeriod ? expectedPeriod.length === 7 : /^\d{4}-\d{2}-\d{2}(?: (?:DST|ST))?$/.test(first);
  const period = expectedPeriod || first.slice(0, daily ? 7 : 10);
  if (daily) validateMonth(period); else validateDate(period);
  if (rows < 1 || rows > (daily ? daysInMonth(period) : 25)) throw new Error('CSV contains an invalid number of report rows.');
  const timestamp = daily ? new RegExp('^' + period + '-\\d{2}(?: (?:DST|ST))?$') :
    new RegExp('^' + period + ' (?:[01]\\d|2[0-3]):00:00(?: (?:DST|ST))?$');
  const dates = new Set();
  for (let index = 2; index <= sheet.rowCount; index++) {
    const row = sheet.getRow(index);
    if (row.cellCount !== headers.length || !timestamp.test(row.getCell(1).text)) {
      throw new Error('CSV rows do not match the expected date or column count.');
    }
    if (daily) {
      const date = row.getCell(1).text.slice(0, 10);
      validateDate(date);
      if (dates.has(date)) throw new Error('Monthly CSV contains a duplicate day.');
      dates.add(date);
    }
    for (const name of required.slice(1)) {
      const value = row.getCell(headers.indexOf(name) + 1).text;
      if (value !== '' && (!/^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value)))) {
        throw new Error('CSV contains an invalid yield reading.');
      }
    }
  }
  return { csvPath, rows, columns: headers.length, granularity: daily ? 'daily' : 'hourly' };
}

module.exports = { validateCsv };
