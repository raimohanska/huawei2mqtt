'use strict';

const { openReport } = require('./session');
const { prepareReport, selectDate, queryDay } = require('./report-ui');
const { useExisting, downloadDay } = require('./downloads');
const { validateDate, previousDate } = require('./dates');

const HELP = `Usage: npm run export:reports -- [options]

With no options, work backwards from today until the first confirmed empty day.
  --from YYYY-MM-DD       Earliest date (inclusive)
  --to YYYY-MM-DD         Latest date (inclusive; default: today in the UI)
  --max-days N            Visit at most N dates, including skipped dates
  --today                 Visit today only (cannot combine with date bounds)
  --headed                Show the browser
  --timeout-minutes N     Per-operation timeout (default: 15; no whole-run limit)
  --help                  Show these instructions

Examples:
  npm run export:reports -- --from 2026-10-20 --to 2026-10-22
  npm run export:reports -- --max-days 3
  npm run export:reports
`;

function options(argv) {
  const result = { timeoutMs: 15 * 60 * 1000, headed: false, today: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help') return { help: true };
    if (arg === '--headed') result.headed = true;
    else if (arg === '--today') result.today = true;
    else if (['--from', '--to', '--max-days', '--timeout-minutes'].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('An option value is missing.');
      if (arg === '--from' || arg === '--to') result[arg.slice(2)] = validateDate(value);
      else {
        const number = Number(value);
        if (!Number.isSafeInteger(number) || number < 1 || number > (arg === '--max-days' ? 100000 : 1440)) {
          throw new Error('Numeric options must be positive integers within the supported range.');
        }
        if (arg === '--max-days') result.maxDays = number;
        else result.timeoutMs = number * 60 * 1000;
      }
    } else throw new Error('Unknown command-line option. Use --help.');
  }
  if (result.from && result.to && result.from > result.to) throw new Error('--from must not be later than --to.');
  if (result.today && (result.from || result.to)) throw new Error('--today cannot be combined with date bounds.');
  return result;
}

async function run(argv) {
  const config = options(argv);
  if (config.help) { console.log(HELP); return; }
  let session;
  let stopping = false;
  let stage = 'initializing';
  let visited = 0;
  let skipped = 0;
  let downloaded = 0;
  let reason = 'date range completed';
  const stop = () => {
    stopping = true;
    console.log('Stopping; completed downloads are retained for the next run.');
    if (session) session.context.close().catch(() => {});
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    let latest = config.to;
    async function ensureSession() {
      if (!session) {
        session = await openReport(config);
        if (stopping) { await session.context.close(); throw new Error('Stopped.'); }
        await prepareReport(session);
      }
    }
    if (!latest) {
      await ensureSession();
      latest = await selectDate(session, 'today');
    }
    const earliest = config.today ? latest : config.from;
    if (earliest && earliest > latest) throw new Error('The date range starts after today.');
    console.log('Working backwards from ' + latest + (earliest ? ' through ' + earliest : ' until no data') +
      '; per-operation timeout ' + config.timeoutMs / 60000 + ' minutes.');
    for (let date = latest; !earliest || date >= earliest; date = previousDate(date)) {
      if (stopping) break;
      if (config.maxDays && visited >= config.maxDays) { reason = 'max-days limit reached'; break; }
      visited++;
      stage = 'checking existing files for ' + date;
      if (await useExisting(date)) { skipped++; continue; }
      await ensureSession();
      stage = 'loading the report for ' + date;
      console.log('Loading ' + date + '.');
      const result = await queryDay(session, date);
      if (result.empty) {
        reason = 'no data on ' + date + ' (confirmed empty response, Total: 0, No data, Export disabled)';
        break;
      }
      stage = 'exporting and converting ' + date;
      await downloadDay(session, date, result.total, config.timeoutMs);
      downloaded++;
    }
    if (stopping) { reason = 'interrupted'; process.exitCode = 130; }
  } catch {
    if (stopping) { reason = 'interrupted'; process.exitCode = 130; }
    else {
      reason = 'failed while ' + stage;
      console.error('Run ' + reason + '. Re-run the same command to resume.');
      process.exitCode = 1;
    }
  } finally {
    if (session) await session.context.close().catch(() => {});
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    console.log('Finished: ' + reason + '. Visited=' + visited + ', downloaded=' + downloaded + ', skipped=' + skipped + '.');
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).catch(error => {
    // Only argument validation escapes run(); it contains no runtime secrets.
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { options, run };
