'use strict';

const { openReport } = require('./session');
const { prepareReport, selectDate, queryDay } = require('./report-ui');
const { useExisting, downloadDay } = require('./downloads');
const { validateDate, previousDate } = require('./dates');
const { describeError } = require('./errors');
const { withRetries } = require('./retry');
const { log, createSkipReporter } = require('./logger');

const NO_DATA_LIMIT = 30;

const HELP = `Usage: npm run export:reports -- [options]

With no options, work backwards from today until 30 consecutive no-data days.
  --from YYYY-MM-DD       Earliest date (inclusive)
  --to YYYY-MM-DD         Latest date (inclusive; default: today in the UI)
  --max-days N            Visit at most N dates, including skipped/empty dates
  --today                 Visit today only (cannot combine with date bounds)
  --headed                Show the browser
  --timeout-minutes N     Download transfer timeout (default: 15 minutes)
  --action-timeout-seconds N  UI actions (default: 30)
  --step-timeout-seconds N    Navigation/report/export steps (default: 120)
  --attempts N            Attempts per day, including the first (default: 3)
  --help                  Show these instructions

Examples:
  npm run export:reports -- --from 2026-10-20 --to 2026-10-22
  npm run export:reports -- --max-days 3
  npm run export:reports
`;

function options(argv) {
  const result = { timeoutMs: 15 * 60 * 1000, actionTimeoutMs: 30000, stepTimeoutMs: 120000, attempts: 3, headed: false, today: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help') return { help: true };
    if (arg === '--headed') result.headed = true;
    else if (arg === '--today') result.today = true;
    else if (['--from', '--to', '--max-days', '--timeout-minutes', '--attempts', '--action-timeout-seconds', '--step-timeout-seconds'].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('An option value is missing.');
      if (arg === '--from' || arg === '--to') result[arg.slice(2)] = validateDate(value);
      else {
        const number = Number(value);
        const max = arg === '--max-days' ? 100000 : arg === '--attempts' ? 10 : arg.endsWith('-seconds') ? 3600 : 1440;
        if (!Number.isSafeInteger(number) || number < 1 || number > max) {
          throw new Error('Numeric options must be positive integers within the supported range.');
        }
        if (arg === '--max-days') result.maxDays = number;
        else if (arg === '--attempts') result.attempts = number;
        else if (arg === '--action-timeout-seconds') result.actionTimeoutMs = number * 1000;
        else if (arg === '--step-timeout-seconds') result.stepTimeoutMs = number * 1000;
        else result.timeoutMs = number * 60 * 1000;
      }
    } else throw new Error('Unknown command-line option. Use --help.');
  }
  if (result.from && result.to && result.from > result.to) throw new Error('--from must not be later than --to.');
  if (result.today && (result.from || result.to)) throw new Error('--today cannot be combined with date bounds.');
  return result;
}

async function run(argv, {
  openReport: open = openReport,
  prepareReport: prepare = prepareReport,
  selectDate: select = selectDate,
  queryDay: query = queryDay,
  useExisting: existing = useExisting,
  downloadDay: download = downloadDay
} = {}) {
  const config = options(argv);
  if (config.help) { log.info(HELP); return; }
  let session;
  let activeContext;
  const abort = new AbortController();
  let stopping = false;
  let stage = 'initializing';
  let visited = 0;
  let skipped = 0;
  let downloaded = 0;
  let emptyDays = 0;
  let emptyStreak = 0;
  let reason = 'date range completed';
  const skippedLog = createSkipReporter();
  const stop = () => {
    stopping = true;
    abort.abort();
    log.info('Stopping; completed CSVs are retained for the next run.');
    if (activeContext) activeContext.close().catch(() => {});
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    let latest = config.to;
    async function resetSession() {
      if (activeContext) await activeContext.close().catch(() => {});
      activeContext = undefined;
      session = undefined;
    }
    async function ensureSession() {
      if (!session) {
        session = await open({ ...config, onContext: context => {
          activeContext = context;
          if (stopping) context.close().catch(() => {});
        } });
        if (stopping) { await session.context.close(); throw new Error('Stopped.'); }
        await prepare(session);
      }
    }
    if (!latest) {
      latest = await withRetries(async () => {
        await ensureSession();
        return select(session, 'today');
      }, {
        attempts: config.attempts, signal: abort.signal,
        onRetry: async error => {
          log.warn('Startup retry: ' + describeError(error));
          await resetSession();
        }
      });
    }
    const earliest = config.today ? latest : config.from;
    if (earliest && earliest > latest) throw new Error('The date range starts after today.');
    log.info('Working backwards from ' + latest + (earliest ? ' through ' + earliest : ' until 30 consecutive no-data days') +
      '; action timeout ' + config.actionTimeoutMs / 1000 + 's, step timeout ' + config.stepTimeoutMs / 1000 +
      's, transfer timeout ' + config.timeoutMs / 60000 + ' minutes.');
    for (let date = latest; !earliest || date >= earliest; date = previousDate(date)) {
      if (stopping) break;
      if (config.maxDays && visited >= config.maxDays) { reason = 'max-days limit reached'; break; }
      visited++;
      stage = 'checking existing files for ' + date;
      if (await existing(date)) {
        skipped++;
        emptyStreak = 0;
        skippedLog.add(date);
        continue;
      }
      skippedLog.flush(date);
      const result = await withRetries(async attempt => {
        // An attempt can finish saving files and then lose the browser while
        // closing the Tasks panel. Do not export that day again on retry.
        if (attempt > 1 && await existing(date)) return { empty: false };
        stage = 'opening the report session for ' + date;
        await ensureSession();
        session.date = date;
        stage = 'loading the report for ' + date;
        const report = await query(session, date);
        if (!report.empty) {
          stage = 'exporting and converting ' + date;
          await download(session, date, report.total, config.timeoutMs);
        }
        return report;
      }, {
        attempts: config.attempts, signal: abort.signal,
        onRetry: async (error, retry) => {
          log.warn('Retry ' + date + ': ' + describeError(error) +
            (session?.step ? '; step=' + session.step : '') +
            '; next attempt ' + retry.nextAttempt + '/' + config.attempts +
            ' after ' + retry.delayMs / 1000 + 's with a fresh browser session.');
          await resetSession();
        }
      });
      if (result.empty) {
        emptyDays++;
        emptyStreak++;
        log.info('No data ' + date + ' (' + emptyStreak + '/' + NO_DATA_LIMIT + ' consecutive)');
        if (emptyStreak >= NO_DATA_LIMIT) {
          reason = NO_DATA_LIMIT + ' consecutive no-data days ending ' + date;
          break;
        }
        continue;
      }
      emptyStreak = 0;
      downloaded++;
      log.info('Exported ' + date);
    }
    if (stopping) { reason = 'interrupted'; process.exitCode = 130; }
  } catch (error) {
    if (stopping) { reason = 'interrupted'; process.exitCode = 130; }
    else {
      reason = 'failed while ' + stage;
      log.error('Run ' + reason + '. Re-run the same command to resume.');
      log.error('Diagnostic: ' + describeError(error) + (session?.step ? '; step=' + session.step : ''));
      process.exitCode = 1;
    }
  } finally {
    if (activeContext) await activeContext.close().catch(() => {});
    skippedLog.flush();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    log.info('Finished: ' + reason + '. Visited=' + visited + ', downloaded=' + downloaded + ', skipped=' + skipped + ', empty=' + emptyDays + '.');
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).catch(error => {
    // Only argument validation escapes run(); it contains no runtime secrets.
    log.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { options, run };
