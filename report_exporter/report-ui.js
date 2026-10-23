'use strict';

const { ExporterError, responseDetails } = require('./errors');
const { captureReportResponse } = require('./report-response');
const { runStep } = require('./steps');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function reportPanel(session) {
  return session.report.getByRole('tabpanel', { name: 'Plant Report', exact: true });
}

async function prepareReport(session) {
  const { report } = session;
  const panel = reportPanel(session);
  await report.getByRole('tab', { name: 'Plant Report', exact: true }).click();
  if (!await panel.getByText('By day', { exact: true }).isVisible()) {
    await panel.getByRole('combobox', { name: 'Time granularity', exact: true }).locator('xpath=../../..').click();
    await report.getByText('By day', { exact: true }).last().click();
  }
  await panel.getByRole('combobox', { name: 'Page Size', exact: true }).locator('xpath=../../..').click();
  await report.getByText('100 / page', { exact: true }).last().click();
}

async function selectDate(session, date) {
  return runStep(session, 'selecting the report date', () => selectCalendarDate(session, date));
}

async function selectCalendarDate(session, date) {
  session.step = 'opening the date picker';
  const input = reportPanel(session).getByRole('textbox', { name: 'Statistical period', exact: true });
  await input.click();
  const calendar = session.report.locator('[class*="picker-dropdown"]:visible');
  if (date === 'today') {
    await calendar.getByText('Today', { exact: true }).click();
  } else {
    session.step = 'navigating the date picker';
    const [year, month] = date.split('-').map(Number);
    let currentYear = Number(await calendar.locator('button[class*="picker-year-btn"]').innerText());
    if (!Number.isInteger(currentYear) || Math.abs(currentYear - year) > 150) throw new ExporterError('CALENDAR_YEAR_INVALID');
    while (currentYear !== year) {
      const previous = currentYear;
      await calendar.locator(currentYear > year ? 'button[class*="picker-header-super-prev-btn"]' : 'button[class*="picker-header-super-next-btn"]').click();
      currentYear = Number(await calendar.locator('button[class*="picker-year-btn"]').innerText());
      if (!Number.isInteger(currentYear) || currentYear === previous) throw new ExporterError('CALENDAR_YEAR_STALLED');
    }
    let currentMonth = MONTHS.indexOf(await calendar.locator('button[class*="picker-month-btn"]').innerText()) + 1;
    if (!currentMonth) throw new ExporterError('CALENDAR_MONTH_INVALID');
    while (currentMonth !== month) {
      const previous = currentMonth;
      await calendar.locator(currentMonth > month ? 'button[class*="picker-header-prev-btn"]' : 'button[class*="picker-header-next-btn"]').click();
      currentMonth = MONTHS.indexOf(await calendar.locator('button[class*="picker-month-btn"]').innerText()) + 1;
      if (!currentMonth || currentMonth === previous) throw new ExporterError('CALENDAR_MONTH_STALLED');
    }
    session.step = 'clicking the calendar day';
    await calendar.locator('td[title="' + date + '"]').click();
  }
  const selected = await input.inputValue();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(selected) || (date !== 'today' && selected !== date)) {
    throw new ExporterError('CALENDAR_DATE_MISMATCH');
  }
  return selected;
}

function validateReportResponse(json) {
  if (!json || !json.data || !Array.isArray(json.data.list) ||
      !Number.isInteger(json.data.total) || json.data.total < 0) {
    throw new ExporterError('REPORT_RESPONSE_INVALID', responseDetails(json));
  }
  const { total, list } = json.data;
  // Observed for 2021-10-22: HTTP 200, success:false, failCode:0,
  // message:null, data:{list:[],total:0,...}. Nonzero failure codes and
  // unrecognized failures must never masquerade as the history boundary.
  const emptyResponse = total === 0 && list.length === 0 && json.failCode === 0 &&
    (json.success === true || (json.success === false && json.message === null));
  if (!emptyResponse && (json.success !== true || json.failCode !== 0)) {
    throw new ExporterError('REPORT_SERVICE_ERROR', responseDetails(json));
  }
  if (!emptyResponse && (total === 0 || list.length !== total || total > 100)) {
    throw new ExporterError('REPORT_INCOMPLETE', responseDetails(json));
  }
  return { empty: emptyResponse, total };
}

async function queryDay(session, date) {
  await selectDate(session, date);
  session.step = 'waiting for the selected date response';
  const panel = reportPanel(session);
  const json = await runStep(session, 'querying the daily report', () =>
    captureReportResponse(session.page, date, session.stepTimeoutMs,
      () => panel.getByRole('button', { name: 'Search', exact: true }).click()));
  session.step = 'validating the report response';
  const result = validateReportResponse(json);
  const { total } = result;
  await runStep(session, 'waiting for the report table', async () => {
    await panel.getByText('Total: ' + total, { exact: true }).waitFor({ timeout: session.stepTimeoutMs });
    await panel.locator('[class*="spin-spinning"]').first().waitFor({ state: 'hidden', timeout: session.stepTimeoutMs });
    if (result.empty) {
      await panel.getByRole('img', { name: 'No data', exact: true }).waitFor({ timeout: session.stepTimeoutMs });
      if (!await panel.getByRole('button', { name: 'Export', exact: true }).isDisabled()) {
        throw new ExporterError('REPORT_EMPTY_UI_INCONSISTENT');
      }
    } else {
      await panel.getByRole('cell', { name: new RegExp('^' + date + ' \\d{2}:\\d{2}:\\d{2}') }).first().waitFor({ timeout: session.stepTimeoutMs });
    }
  });
  return result;
}

module.exports = { prepareReport, selectDate, reportPanel, queryDay, validateReportResponse };
