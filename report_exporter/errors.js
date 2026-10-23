'use strict';

class ExporterError extends Error {
  constructor(code, details = {}, { retryable = true } = {}) {
    super(code);
    this.code = code;
    this.details = details;
    this.retryable = retryable;
  }
}

function describeError(error) {
  if (error instanceof ExporterError) return error.code + ' ' + JSON.stringify(error.details);
  // Classify browser failures without printing messages, call logs, URLs, or
  // selector arguments, any of which can contain login credentials.
  const message = String(error?.message || '');
  if (error?.name === 'TimeoutError') return 'PLAYWRIGHT_TIMEOUT';
  if (message.includes('strict mode violation')) return 'AMBIGUOUS_LOCATOR';
  if (/Target .*closed|has been closed|browser.*closed/i.test(message)) return 'BROWSER_CLOSED';
  if (/intercepts pointer events/.test(message)) return 'UI_CLICK_INTERCEPTED';
  return 'UNEXPECTED_ERROR';
}

function responseDetails(json) {
  const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  return {
    success: typeof json?.success === 'boolean' ? json.success : null,
    failCode: number(json?.failCode),
    total: number(json?.data?.total),
    rows: Array.isArray(json?.data?.list) ? json.data.list.length : null
  };
}

module.exports = { ExporterError, describeError, responseDetails };
