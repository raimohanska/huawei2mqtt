'use strict';

const { openReport } = require('./session');
const { prepareReport, selectDate, queryDay, queryMonth } = require('./report-ui');
const { useExisting, downloadDay } = require('./downloads');
const { validateDate, previousDate, previousMonth } = require('./dates');
const { describeError } = require('./errors');
const { withRetries } = require('./retry');
const { log, createSkipReporter } = require('./logger');

const HELP = `Usage: npm run export:reports -- [options]

Work backwards through hourly reports (By day). At the first no-data day,
switch to monthly reports (By month) containing daily yields. Fetch months
from the latest requested month backwards until the first no-data month.
  --from YYYY-MM-DD       Earliest date (inclusive; monthly phase includes its month)
  --to YYYY-MM-DD         Latest date (inclusive; default: today in the UI)
  --max-days N            Limit hourly dates visited, including skipped dates
  --max-months N          Limit monthly reports visited, including skipped months
  --monthly-only          Fetch monthly reports with daily yields immediately
  --hourly-only           Do not switch to monthly reports
  --today                 Hourly report for today only
  --headed                Show the browser
  --timeout-minutes N     Download transfer timeout (default: 15 minutes)
  --action-timeout-seconds N  UI actions (default: 30)
  --step-timeout-seconds N    Navigation/report/export steps (default: 120)
  --attempts N            Attempts per report, including the first (default: 3)
  --help                  Show these instructions

Examples:
  npm run export:reports
  npm run export:reports -- --monthly-only
  npm run export:reports -- --monthly-only --from 2026-05-01 --to 2026-06-30 --max-months 2
`;

function options(argv) {
  const result = { timeoutMs: 900000, actionTimeoutMs: 30000, stepTimeoutMs: 120000,
    attempts: 3, headed: false, today: false, monthlyOnly: false, hourlyOnly: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help') return { help: true };
    if (arg === '--headed') result.headed = true;
    else if (arg === '--today') result.today = true;
    else if (arg === '--monthly-only') result.monthlyOnly = true;
    else if (arg === '--hourly-only') result.hourlyOnly = true;
    else if (['--from', '--to', '--max-days', '--max-months', '--timeout-minutes', '--attempts', '--action-timeout-seconds', '--step-timeout-seconds'].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('An option value is missing.');
      if (arg === '--from' || arg === '--to') result[arg.slice(2)] = validateDate(value);
      else {
        const number = Number(value);
        const max = arg.startsWith('--max-') ? 100000 : arg === '--attempts' ? 10 : arg.endsWith('-seconds') ? 3600 : 1440;
        if (!Number.isSafeInteger(number) || number < 1 || number > max) {
          throw new Error('Numeric options must be positive integers within the supported range.');
        }
        if (arg === '--max-days') result.maxDays = number;
        else if (arg === '--max-months') result.maxMonths = number;
        else if (arg === '--attempts') result.attempts = number;
        else if (arg === '--action-timeout-seconds') result.actionTimeoutMs = number * 1000;
        else if (arg === '--step-timeout-seconds') result.stepTimeoutMs = number * 1000;
        else result.timeoutMs = number * 60000;
      }
    } else throw new Error('Unknown command-line option. Use --help.');
  }
  if (result.from && result.to && result.from > result.to) throw new Error('--from must not be later than --to.');
  if (result.today && (result.from || result.to)) throw new Error('--today cannot be combined with date bounds.');
  if (result.monthlyOnly && (result.hourlyOnly || result.today || result.maxDays)) {
    throw new Error('--monthly-only cannot combine with --hourly-only, --today or --max-days; use --max-months.');
  }
  if (result.today) result.hourlyOnly = true;
  return result;
}

async function run(argv, {
  openReport: open = openReport,
  prepareReport: prepare = prepareReport,
  selectDate: select = selectDate,
  queryDay: query = queryDay,
  queryMonth: queryMonthly = queryMonth,
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
  let empty = 0;
  let hourlyDownloaded = 0;
  let monthlyDownloaded = 0;
  let reason = 'date range completed';
  const daySkips = createSkipReporter();
  const monthSkips = createSkipReporter(log.info, 'month');
  const stop = () => {
    stopping = true;
    abort.abort();
    log.info('Stopping; completed CSVs are retained for the next run.');
    if (activeContext) activeContext.close().catch(() => {});
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    async function resetSession() {
      if (activeContext) await activeContext.close().catch(() => {});
      activeContext = undefined;
      session = undefined;
    }
    async function ensureSession(granularity) {
      if (!session) {
        session = await open({ ...config, onContext: context => {
          activeContext = context;
          if (stopping) context.close().catch(() => {});
        } });
      }
      if (stopping) { await session.context.close(); throw new Error('Stopped.'); }
      if (session.granularity !== granularity) {
        await prepare(session, granularity);
        session.granularity = granularity;
      }
    }
    async function visit(period, granularity) {
      visited++;
      const skipLog = granularity === 'daily' ? monthSkips : daySkips;
      stage = 'checking existing files for ' + period;
      if (await existing(period)) {
        skipped++;
        skipLog.add(period);
        return { empty: false, skipped: true };
      }
      skipLog.flush(period);
      const result = await withRetries(async attempt => {
        if (attempt > 1 && await existing(period)) return { empty: false };
        stage = 'opening the report session for ' + period;
        await ensureSession(granularity);
        session.date = period;
        stage = 'loading the report for ' + period;
        const report = await (granularity === 'daily' ? queryMonthly : query)(session, period);
        if (!report.empty) {
          stage = 'exporting and converting ' + period;
          await download(session, period, report.total, config.timeoutMs);
        }
        return report;
      }, {
        attempts: config.attempts, signal: abort.signal,
        onRetry: async (error, retry) => {
          log.warn('Retry ' + period + ': ' + describeError(error) +
            (session?.step ? '; step=' + session.step : '') +
            '; next attempt ' + retry.nextAttempt + '/' + config.attempts +
            ' after ' + retry.delayMs / 1000 + 's with a fresh browser session.');
          await resetSession();
        }
      });
      if (result.empty) { empty++; return result; }
      downloaded++;
      if (granularity === 'daily') monthlyDownloaded++; else hourlyDownloaded++;
      log.info('Exported ' + period + (granularity === 'daily' ? ' (daily yields)' : ''));
      return result;
    }

    let latest = config.to;
    if (!latest) {
      latest = await withRetries(async () => {
        await ensureSession('hourly');
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
    log.info('Working backwards from ' + latest + (earliest ? ' through ' + earliest : '') +
      '; action timeout ' + config.actionTimeoutMs / 1000 + 's, step timeout ' + config.stepTimeoutMs / 1000 +
      's, transfer timeout ' + config.timeoutMs / 60000 + ' minutes.');

    let fetchMonths = config.monthlyOnly;
    if (!config.monthlyOnly) {
      let daysVisited = 0;
      for (let date = latest; !earliest || date >= earliest; date = previousDate(date)) {
        if (stopping) break;
        if (config.maxDays && daysVisited >= config.maxDays) { reason = 'max-days limit reached'; break; }
        daysVisited++;
        const result = await visit(date, 'hourly');
        if (result.empty) {
          reason = 'no hourly data on ' + date;
          log.info('No hourly data ' + date);
          fetchMonths = !config.hourlyOnly;
          break;
        }
      }
      daySkips.flush();
    }
    if (fetchMonths && !stopping) {
      const firstMonth = latest.slice(0, 7);
      const lastMonth = earliest?.slice(0, 7);
      log.info('Fetching monthly reports with daily yields from ' + firstMonth + ' backwards.');
      reason = 'monthly date range completed';
      let monthsVisited = 0;
      for (let month = firstMonth; !lastMonth || month >= lastMonth; month = previousMonth(month)) {
        if (stopping) break;
        if (config.maxMonths && monthsVisited >= config.maxMonths) { reason = 'max-months limit reached'; break; }
        monthsVisited++;
        const result = await visit(month, 'daily');
        if (result.empty) {
          reason = 'no daily data in month ' + month;
          log.info('No daily data ' + month);
          break;
        }
      }
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
    daySkips.flush();
    monthSkips.flush();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    log.info('Finished: ' + reason + '. Visited=' + visited + ', downloaded=' + downloaded + ', skipped=' + skipped +
      ', empty=' + empty + ', hourly=' + hourlyDownloaded + ', monthly=' + monthlyDownloaded + '.');
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).catch(error => {
    log.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { options, run };
