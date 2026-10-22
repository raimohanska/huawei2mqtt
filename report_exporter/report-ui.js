'use strict';

const { plantDate } = require('./dates');

const REPORT_PATH = '/rest/pvms/web/report/v1/station/station-kpi-list';
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
  const input = reportPanel(session).getByRole('textbox', { name: 'Statistical period', exact: true });
  await input.click();
  const calendar = session.report.locator('[class*="picker-dropdown"]:visible');
  if (date === 'today') {
    await calendar.getByText('Today', { exact: true }).click();
  } else {
    const [year, month] = date.split('-').map(Number);
    let currentYear = Number(await calendar.locator('button[class*="picker-year-btn"]').innerText());
    if (!Number.isInteger(currentYear) || Math.abs(currentYear - year) > 150) throw new Error('Unexpected calendar year.');
    while (currentYear !== year) {
      await calendar.locator(currentYear > year ? 'button[class*="picker-header-super-prev-btn"]' : 'button[class*="picker-header-super-next-btn"]').click();
      currentYear = Number(await calendar.locator('button[class*="picker-year-btn"]').innerText());
    }
    let currentMonth = MONTHS.indexOf(await calendar.locator('button[class*="picker-month-btn"]').innerText()) + 1;
    if (!currentMonth) throw new Error('Unexpected calendar month.');
    while (currentMonth !== month) {
      await calendar.locator(currentMonth > month ? 'button[class*="picker-header-prev-btn"]' : 'button[class*="picker-header-next-btn"]').click();
      currentMonth = MONTHS.indexOf(await calendar.locator('button[class*="picker-month-btn"]').innerText()) + 1;
    }
    await calendar.locator('td[title="' + date + '"]').click();
  }
  const selected = await input.inputValue();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(selected) || (date !== 'today' && selected !== date)) {
    throw new Error('Calendar did not select the requested date.');
  }
  return selected;
}

function validateReportResponse(json) {
  if (!json || !json.data || !Array.isArray(json.data.list) ||
      !Number.isInteger(json.data.total) || json.data.total < 0) {
    throw new Error('Report service did not return a valid report.');
  }
  const { total, list } = json.data;
  // Observed for 2021-10-22: HTTP 200, success:false, failCode:0,
  // message:null, data:{list:[],total:0,...}. Nonzero failure codes and
  // unrecognized failures must never masquerade as the history boundary.
  const emptyResponse = total === 0 && list.length === 0 && json.failCode === 0 &&
    (json.success === true || (json.success === false && json.message === null));
  if (!emptyResponse && (json.success !== true || json.failCode !== 0)) {
    throw new Error('Report service returned an error.');
  }
  if (!emptyResponse && (total === 0 || list.length !== total || total > 100)) {
    throw new Error('Incomplete daily report.');
  }
  return { empty: emptyResponse, total };
}

async function queryDay(session, date) {
  await selectDate(session, date);
  const panel = reportPanel(session);
  // A page-size change can leave an older query in flight. Match the requested
  // plant-local date as well as the endpoint so stale rows cannot stop a run.
  const [response] = await Promise.all([
    session.page.waitForResponse(response => {
      if (new URL(response.url()).pathname !== REPORT_PATH) return false;
      try {
        const request = response.request().postDataJSON();
        return Number(request.statDim) === 2 && plantDate(request.statTime) === date;
      } catch { return false; }
    }),
    panel.getByRole('button', { name: 'Search', exact: true }).click()
  ]);
  if (!response.ok()) throw new Error('Report request failed.');
  const result = validateReportResponse(await response.json());
  const { total } = result;
  await panel.getByText('Total: ' + total, { exact: true }).waitFor();
  await panel.locator('[class*="spin-spinning"]').first().waitFor({ state: 'hidden' });
  if (result.empty) {
    await panel.getByRole('img', { name: 'No data', exact: true }).waitFor();
    if (!await panel.getByRole('button', { name: 'Export', exact: true }).isDisabled()) {
      throw new Error('Empty report state is inconsistent.');
    }
    return result;
  }
  await panel.getByRole('cell', { name: new RegExp('^' + date + ' \\d{2}:\\d{2}:\\d{2}') }).first().waitFor();
  return result;
}

module.exports = { prepareReport, selectDate, reportPanel, queryDay, validateReportResponse };
