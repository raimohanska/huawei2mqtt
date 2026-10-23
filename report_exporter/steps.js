'use strict';

const { ExporterError } = require('./errors');
const { log } = require('./logger');

async function runStep(session, step, operation, { timeoutMs = session.stepTimeoutMs, progressMs = 30000 } = {}) {
  session.step = step;
  const started = Date.now();
  let timer;
  let progress;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new ExporterError('STEP_TIMEOUT', { step, timeoutSeconds: timeoutMs / 1000 }));
      // Cancel the browser operation as well as the wait. The retry must not
      // leave an old page/request working beside the fresh session.
      session.context.close().catch(() => {});
    }, timeoutMs);
  });
  if (progressMs > 0 && timeoutMs > progressMs) {
    progress = setInterval(() => log.warn('Step: ' + step + (session.date ? ' (' + session.date + ')' : '') +
      '; ' + Math.round((Date.now() - started) / 1000) + 's elapsed, limit ' + timeoutMs / 1000 + 's.'), progressMs);
  }
  try { return await Promise.race([Promise.resolve().then(operation), deadline]); }
  finally { clearTimeout(timer); clearInterval(progress); }
}

module.exports = { runStep };
