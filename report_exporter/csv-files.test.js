'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { convertToCsv } = require('./convert-csv');
const { validateCsv } = require('./validate-csv');
const { useExisting } = require('./downloads');
const { log, timestamp, createSkipReporter } = require('./logger');
const { expectedHourlySlots } = require('./dates');

const DATE = '2026-10-21';
const HEADER = 'Statistical Period,PV Yield (kWh),Inverter Yield (kWh)\r\n';
const CSV = HEADER + DATE + ' 00:00:00 DST,0,0\r\n' + DATE + ' 01:00:00 DST,,\r\n';
const NOW = Date.parse('2026-11-02T12:00:00Z');
const HOURS = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0'));
const hourlyCsv = (date, hours = HOURS) => HEADER + hours.map(hour => date + ' ' + hour + ':00:00,0,0\r\n').join('');
const monthlyCsv = (month, count) => HEADER + Array.from({ length: count }, (_, index) =>
  month + '-' + String(index + 1).padStart(2, '0') + ',0,0\r\n').join('');

async function temporaryTest(work) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fusionsolar-csv-'));
  try { await work(root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

async function workbook(filename, date = DATE) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Report');
  sheet.addRow(['Plant Report_Test']);
  sheet.addRow(['Statistical Period', 'PV Yield (kWh)', ' Inverter Yield (kWh)', 'Notes']);
  sheet.addRow([date + ' 00:00:00 DST', 0, 0, 'comma, newline\nand "quotes"']);
  sheet.addRow([date + ' 01:00:00 DST', null, null, '']);
  await book.xlsx.writeFile(filename);
}

test('conversion publishes a validated CSV then deletes XLSX; missing/zero and quoted fields survive', async () => {
  await temporaryTest(async root => {
    const source = path.join(root, DATE + '.xlsx');
    await workbook(source);
    const result = await convertToCsv(source, DATE);
    assert.equal(result.rows, 2);
    assert.equal(result.columns, 4);
    await assert.rejects(fs.access(source), { code: 'ENOENT' });
    assert.equal((await validateCsv(result.csvPath, DATE)).rows, 2);
    const text = await fs.readFile(result.csvPath, 'utf8');
    assert.ok(text.includes(',0,0,"comma, newline\nand ""quotes"""'));
    assert.ok(text.includes(DATE + ' 01:00:00 DST,,,\r\n'));
  });
});

test('wrong-day and wrong-row-count conversions retain XLSX and do not publish completion CSV', async () => {
  await temporaryTest(async root => {
    const source = path.join(root, DATE + '.partial.xlsx');
    const destination = path.join(root, DATE + '.csv');
    await workbook(source);
    await assert.rejects(convertToCsv(source, '2026-10-20', { csvPath: destination }));
    await fs.access(source);
    await assert.rejects(fs.access(destination), { code: 'ENOENT' });
    await assert.rejects(convertToCsv(source, DATE, { csvPath: destination, expectedRows: 24 }));
    await fs.access(source);
    await assert.rejects(fs.access(destination), { code: 'ENOENT' });
    await convertToCsv(source, DATE, { csvPath: destination, expectedRows: 2 });
    await fs.access(destination);
    await assert.rejects(fs.access(source), { code: 'ENOENT' });
  });
});

test('CSV alone skips a day; validated CSV also removes redundant legacy XLSX', async () => {
  await temporaryTest(async root => {
    const directory = path.join(root, '2026', '10');
    await fs.mkdir(directory, { recursive: true });
    const csv = path.join(directory, DATE + '.csv');
    const complete = hourlyCsv(DATE);
    await fs.writeFile(csv, complete);
    assert.equal(await useExisting(DATE, { root, now: NOW }), true);
    const legacy = path.join(directory, DATE + '.xlsx');
    await fs.writeFile(legacy, 'obsolete workbook');
    assert.equal(await useExisting(DATE, { root, now: NOW }), true);
    await assert.rejects(fs.access(legacy), { code: 'ENOENT' });
    assert.equal(await fs.readFile(csv, 'utf8'), complete);
  });
});

test('partial legacy XLSX is converted and removed but its day still requires refresh', async () => {
  await temporaryTest(async root => {
    const directory = path.join(root, '2026', '10');
    await fs.mkdir(directory, { recursive: true });
    const legacy = path.join(directory, DATE + '.xlsx');
    await workbook(legacy);
    assert.equal(await useExisting(DATE, { root, now: NOW }), false);
    await assert.rejects(fs.access(legacy), { code: 'ENOENT' });
    assert.equal((await validateCsv(path.join(directory, DATE + '.csv'), DATE)).rows, 2);
  });
});

test('invalid final CSV stops without deleting legacy XLSX; partial files do not mark completion', async () => {
  await temporaryTest(async root => {
    const directory = path.join(root, '2026', '10');
    await fs.mkdir(directory, { recursive: true });
    const csv = path.join(directory, DATE + '.csv');
    const legacy = path.join(directory, DATE + '.xlsx');
    await fs.writeFile(csv, HEADER);
    await fs.writeFile(legacy, 'keep this source');
    await assert.rejects(useExisting(DATE, { root }), error => error.code === 'EXISTING_CSV_INVALID' && !error.retryable);
    assert.equal(await fs.readFile(legacy, 'utf8'), 'keep this source');
    await fs.unlink(csv);
    await fs.unlink(legacy);
    await fs.writeFile(csv + '.partial', CSV);
    await fs.writeFile(path.join(directory, DATE + '.partial.xlsx'), 'partial');
    assert.equal(await useExisting(DATE, { root }), false);
  });
});

test('CSV validation rejects wrong dates, missing fields, and nonnumeric yields', async () => {
  await temporaryTest(async root => {
    const csv = path.join(root, 'report.csv');
    for (const content of [CSV.replaceAll(DATE, '2026-10-20'),
      HEADER + DATE + ' 00:00:00 DST,1\r\n',
      HEADER + DATE + ' 00:00:00 DST,bad,0\r\n']) {
      await fs.writeFile(csv, content);
      await assert.rejects(validateCsv(csv, DATE));
    }
    for (const content of [CSV.replaceAll(' DST', ''), CSV.replaceAll(' DST', ' ST')]) {
      await fs.writeFile(csv, content);
      assert.equal((await validateCsv(csv, DATE)).rows, 2);
    }
  });
});

test('log lines include local timestamp/offset and successful days are single-line', () => {
  const date = new Date('2026-10-23T12:34:56.789Z');
  assert.equal(Date.parse(timestamp(date)), date.getTime());
  const lines = [];
  const original = console.log;
  console.log = text => lines.push(text);
  try {
    log.info('Exported ' + DATE);
    assert.equal(lines.length, 1);
    log.info('first\nsecond');
  } finally { console.log = original; }
  assert.equal(lines.length, 3);
  for (const line of lines) assert.match(line, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2} \[INFO\] /);
  assert.ok(lines[0].endsWith(' [INFO] Exported ' + DATE));
});

test('consecutive skipped dates produce one summary, including all-skipped bounded runs', () => {
  const lines = [];
  const skipped = createSkipReporter(line => lines.push(line));
  skipped.add('2026-10-22');
  skipped.add('2026-10-21');
  skipped.add('2026-10-20');
  assert.deepEqual(lines, []);
  skipped.flush('2026-10-19');
  assert.deepEqual(lines, ['Skipping to 2026-10-19 because 3 days already have valid CSVs.']);
  skipped.flush();
  assert.equal(lines.length, 1);
  skipped.add('2026-10-18');
  skipped.flush();
  assert.equal(lines[1], 'Skipping through 2026-10-18 because 1 day already has a valid CSV.');
});

test('monthly workbooks convert daily dates and remove XLSX only after validating the month', async () => {
  await temporaryTest(async root => {
    const source = path.join(root, '2026-06.xlsx');
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Report');
    sheet.addRow(['Plant Report_Test']);
    sheet.addRow(['Statistical Period', 'PV Yield (kWh)', ' Inverter Yield (kWh)']);
    for (let day = 1; day <= 30; day++) sheet.addRow(['2026-06-' + String(day).padStart(2, '0'), day === 1 ? 0 : 1.25, null]);
    await book.xlsx.writeFile(source);
    await assert.rejects(convertToCsv(source, '2026-05'));
    await fs.access(source);
    const converted = await convertToCsv(source, '2026-06', { expectedRows: 30 });
    assert.equal(converted.rows, 30);
    assert.equal(converted.granularity, 'daily');
    await assert.rejects(fs.access(source), { code: 'ENOENT' });
    assert.equal((await validateCsv(converted.csvPath, '2026-06')).granularity, 'daily');
    await assert.rejects(validateCsv(converted.csvPath, '2026-06-01'));
  });
});

test('monthly CSVs have separate storage and never masquerade as hourly completion', async () => {
  await temporaryTest(async root => {
    const hourly = path.join(root, '2026', '06');
    const daily = path.join(root, 'daily', '2026');
    await fs.mkdir(hourly, { recursive: true });
    await fs.mkdir(daily, { recursive: true });
    const hourlyCsv = path.join(hourly, '2026-06-01.csv');
    await fs.writeFile(hourlyCsv, HEADER + HOURS.map(hour => '2026-06-01 ' + hour + ':00:00,0,0\r\n').join(''));
    assert.equal(await useExisting('2026-06', { root }), false);
    await fs.writeFile(path.join(daily, '2026-06.csv'), HEADER + '2026-06-01,0,0\r\n2026-06-02,1.5,1.5\r\n');
    assert.equal(await useExisting('2026-06', { root, now: NOW }), false);
    await fs.writeFile(path.join(daily, '2026-06.csv'), monthlyCsv('2026-06', 30));
    assert.equal(await useExisting('2026-06', { root, now: NOW }), true);
    assert.equal(await useExisting('2026-06-01', { root, now: NOW }), true);
    assert.equal(await useExisting('2026-06-02', { root }), false);
    await fs.access(hourlyCsv);
  });
});

test('past hourly files with missing or duplicated hours are refreshed rather than skipped', async () => {
  await temporaryTest(async root => {
    const directory = path.join(root, '2026', '10');
    await fs.mkdir(directory, { recursive: true });
    const csv = path.join(directory, DATE + '.csv');
    for (const hours of [HOURS.slice(0, 23), HOURS.map(hour => hour === '13' ? '12' : hour)]) {
      const content = hourlyCsv(DATE, hours);
      await fs.writeFile(csv, content);
      const result = await validateCsv(csv, DATE, { now: NOW });
      assert.equal(result.expectedRows, 24);
      assert.equal(result.rowsComplete, false);
      assert.equal(await useExisting(DATE, { root, now: NOW }), false);
      assert.equal(await fs.readFile(csv, 'utf8'), content);
    }
    await fs.writeFile(csv, hourlyCsv(DATE));
    assert.equal(await useExisting(DATE, { root, now: NOW }), true);
  });
});

test('hourly completeness accounts for 23/25-hour Helsinki DST days', async () => {
  await temporaryTest(async root => {
    const csv = path.join(root, 'report.csv');
    const spring = '2026-03-29';
    const autumn = '2026-10-25';
    assert.equal(expectedHourlySlots(spring).length, 23);
    assert.ok(!expectedHourlySlots(spring).includes(spring + ' 03:00:00'));
    assert.equal(expectedHourlySlots(autumn).length, 25);
    assert.equal(expectedHourlySlots(autumn).filter(slot => slot.endsWith('03:00:00')).length, 2);
    await fs.writeFile(csv, hourlyCsv(spring, HOURS.filter(hour => hour !== '03')));
    assert.equal((await validateCsv(csv, spring, { now: NOW })).complete, true);
    await fs.writeFile(csv, hourlyCsv(autumn));
    assert.equal((await validateCsv(csv, autumn, { now: NOW })).complete, false);
    const autumnHours = [...HOURS];
    autumnHours.splice(4, 0, '03');
    await fs.writeFile(csv, hourlyCsv(autumn, autumnHours));
    assert.equal((await validateCsv(csv, autumn, { now: NOW })).complete, true);
  });
});

test('monthly completeness requires every day, including leap day', async () => {
  await temporaryTest(async root => {
    const directory = path.join(root, 'daily', '2024');
    await fs.mkdir(directory, { recursive: true });
    const csv = path.join(directory, '2024-02.csv');
    await fs.writeFile(csv, monthlyCsv('2024-02', 28));
    assert.equal((await validateCsv(csv, '2024-02', { now: NOW })).expectedRows, 29);
    assert.equal(await useExisting('2024-02', { root, now: NOW }), false);
    await fs.writeFile(csv, monthlyCsv('2024-02', 29));
    assert.equal(await useExisting('2024-02', { root, now: NOW }), true);
    await fs.writeFile(csv, monthlyCsv('2024-02', 29).replace('2024-02-15,0,0\r\n', ''));
    assert.equal(await useExisting('2024-02', { root, now: NOW }), false);
  });
});

test('current day and month are refreshed even if all rows have been prepopulated', async () => {
  await temporaryTest(async root => {
    const hourly = path.join(root, '2026', '10');
    const daily = path.join(root, 'daily', '2026');
    await fs.mkdir(hourly, { recursive: true });
    await fs.mkdir(daily, { recursive: true });
    await fs.writeFile(path.join(hourly, '2026-10-23.csv'), hourlyCsv('2026-10-23'));
    await fs.writeFile(path.join(daily, '2026-10.csv'), monthlyCsv('2026-10', 31));
    const current = Date.parse('2026-10-23T12:00:00Z');
    assert.equal(await useExisting('2026-10-23', { root, now: current }), false);
    assert.equal(await useExisting('2026-10', { root, now: current }), false);
    assert.equal(await useExisting('2026-10-23', { root, now: NOW }), true);
    assert.equal(await useExisting('2026-10', { root, now: NOW }), true);
  });
});

test('monthly CSV validation checks real calendar dates, duplicates, and leap days', async () => {
  await temporaryTest(async root => {
    const csv = path.join(root, 'month.csv');
    for (const rows of ['2026-06-31,1,1\r\n', '2026-06-01,1,1\r\n2026-06-01,2,2\r\n',
      '2026-05-31,1,1\r\n', '2026-06-01 00:00:00 DST,1,1\r\n']) {
      await fs.writeFile(csv, HEADER + rows);
      await assert.rejects(validateCsv(csv, '2026-06'));
    }
    await fs.writeFile(csv, HEADER + '2024-02-29,0,0\r\n');
    assert.equal((await validateCsv(csv, '2024-02')).rows, 1);
    await fs.writeFile(csv, HEADER + '2025-02-29,0,0\r\n');
    await assert.rejects(validateCsv(csv, '2025-02'));
  });
});
