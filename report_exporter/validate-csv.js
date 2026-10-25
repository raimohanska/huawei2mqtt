'use strict';

const ExcelJS = require('exceljs');
const { validateDate, validateMonth, daysInMonth, expectedHourlySlots, plantDate } = require('./dates');

async function validateCsv(csvPath, expectedPeriod, { now = Date.now(), sheet } = {}) {
  // Use the CSV reader already provided by ExcelJS, preserving timestamp text
  // and blank/zero values. Importers can reuse an already parsed worksheet.
  if (!sheet) {
    const workbook = new ExcelJS.Workbook();
    sheet = await workbook.csv.readFile(csvPath, { map: value => value });
  }
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
  const hours = new Map();
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
    } else {
      const hour = row.getCell(1).text.slice(0, 19);
      hours.set(hour, (hours.get(hour) || 0) + 1);
    }
    for (const name of required.slice(1)) {
      const value = row.getCell(headers.indexOf(name) + 1).text;
      if (value !== '' && (!/^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value)))) {
        throw new Error('CSV contains an invalid yield reading.');
      }
    }
  }
  const expectedHours = daily ? [] : expectedHourlySlots(period);
  const expectedRows = daily ? daysInMonth(period) : expectedHours.length;
  const remaining = new Map(hours);
  for (const hour of expectedHours) remaining.set(hour, (remaining.get(hour) || 0) - 1);
  const rowsComplete = rows === expectedRows && (daily || [...remaining.values()].every(count => count === 0));
  // Even a prepopulated current-period report may still have changing readings.
  const periodEnded = period < plantDate(now).slice(0, daily ? 7 : 10);
  return { csvPath, rows, expectedRows, rowsComplete, complete: rowsComplete && periodEnded,
    columns: headers.length, granularity: daily ? 'daily' : 'hourly' };
}

module.exports = { validateCsv };
