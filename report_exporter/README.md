# FusionSolar report exporter

Playwright automation for plant **134568461**, running locally with Node.js 22
or newer. Run the following commands from `report_exporter/`.

## Setup

```sh
npm ci
npm run browser:install
```

Configure these variables locally in `report_exporter/.env`:

- `HUAWEI_LOGIN_PAGE`: HTTPS login URL.
- `HUAWEI_USERNAME`: account username.
- `HUAWEI_PASSWORD`: account password.

Application code loads `.env` at runtime, preserving existing process environment
values. The repository-root [`AGENTS.md`](../AGENTS.md) forbids LLMs and coding
agents from reading credential files.
Credentials, authentication headers, and raw browser errors are never printed.

## Full history: hourly first, then daily yields

From the project root:

```sh
cd report_exporter
npm run export:reports
```

The default run has two phases:

1. **Hourly readings:** select **By day** and **100 / page**, work backwards from
   today, and skip complete hourly CSVs for finished days. At the **first confirmed no-data day**,
   stop querying older hourly dates and switch to the second phase.
2. **Daily yields:** select **By month** and **100 / page**. Download monthly
   reports containing one row per day, starting at the **latest requested month**
   and working backwards until the **first confirmed no-data month**.

The daily-yield phase covers the whole available monthly history, including
months that also have hourly data. It does not start only at the hourly cutoff.
The former 30-empty-day rule no longer applies.

Press **Ctrl+C** to stop. Re-run the same command to resume. An already-running
process keeps its loaded code; restart it to apply these changes. Run only one
exporter at a time with the shared browser profile.

### Fetch daily yields immediately

If hourly history is already downloaded, start the monthly-report phase directly:

```sh
npm run export:reports -- --monthly-only
```

To fetch hourly data only, stopping at its first missing day:

```sh
npm run export:reports -- --hourly-only
```

`npm run export:today` still fetches only today's hourly report.

## Bounded runs and trials

Both date bounds are inclusive. `--from` is oldest and `--to` is newest; dates
are always visited in descending order. Omitting `--to` starts today in the UI.

```sh
# Hourly trial; monthly fallback occurs only if an hourly no-data day is reached.
npm run export:reports -- --from 2026-10-20 --to 2026-10-22 --max-days 3 --max-months 2

# Exactly the May/June monthly reports, containing daily yields.
npm run export:reports -- --monthly-only --from 2026-05-01 --to 2026-06-30 --max-months 2

# At most three hourly dates.
npm run export:reports -- --max-days 3

# At most three monthly reports, skipping the hourly phase.
npm run export:reports -- --monthly-only --max-months 3
```

- `--max-days` counts hourly dates visited, including skipped and empty days.
- `--max-months` counts monthly reports visited, including skipped/empty months.
- If hourly date bounds or `--max-days` finish before a missing hourly day,
  the run ends without starting monthly backfill.
- In the monthly phase, date bounds select **whole months**. For example,
  `--from 2026-05-15` includes the complete May report, not just May 15 onward.
- A missing month ends monthly traversal even if bounds/limits allow older months.
- `--monthly-only` cannot combine with `--today`, `--hourly-only`, or `--max-days`.
  Use `--max-months` to bound a monthly-only run.

## CSV output and resume

Hourly CSVs retain their existing paths. Monthly reports with daily yields use a
separate directory:

```text
exports/134568461/YYYY/MM/YYYY-MM-DD.csv       # hourly rows for one day
exports/134568461/daily/YYYY/YYYY-MM.csv       # daily rows for one month
```

The **final CSV is checked for completeness before it acts as a skip marker**.
An hourly CSV does not mark its month as downloaded, and a monthly daily-yield
CSV does not mark hourly dates complete. Both types are validated for required
headers, matching period, row width, and numeric/blank yields.

- **Hourly files:** require every actual hour in the plant's Helsinki-local day.
  This is normally 24 rows, 23 at the spring DST change, and 25 at the autumn
  change. The script checks hour coverage and repeated-hour counts, not just the
  number of rows, so a duplicate ordinary hour cannot hide a missing hour.
- **Monthly files:** require every calendar day of the month (28–31 rows,
  including leap day), with no duplicate or invalid dates.
- **Current day and month:** always refreshed, even if their rows have been
  prepopulated, because readings may still change. Plant-local time determines
  whether the period has ended.
- **Older incomplete files:** retained but fetched again; only complete files
  for finished periods are skipped. Missing yield values are kept distinct from
  missing rows, since blank nighttime readings are legitimate.

Downloads first use `.partial.xlsx`. Conversion writes `.csv.partial`, checks
its contents and row count against the report UI, publishes the final CSV by
atomic rename, then **deletes the XLSX**. Failed conversions retain the source;
partial files never count as completed reports.

When revisiting old downloads, redundant XLSX files are removed after validating
their CSV. An XLSX-only report is converted locally and then checked for
completeness. Invalid final CSVs stop the run rather than being silently
overwritten. Existing CSVs are checked locally; only missing, incomplete, or
current-period reports need the browser.

CSV conversion retains every report column, omits the decorative title/empty
worksheets, preserves timestamps and missing-versus-zero readings, and uses
UTF-8, comma separators, standard quoting, and CRLF line endings. Current-day
and current-month files are snapshots of the readings available at export time.
They are saved even when partial and refreshed on each subsequent run. A partial
CSV is replaced atomically only after the new report has converted successfully.

Standalone conversion also validates and saves the CSV before deleting the XLSX:

```sh
npm run convert:csv -- path/to/report.xlsx
```

`exports/` and `.playwright/` (browser profile/authentication) are ignored by Git.

## Timeouts, recovery, and logs

| Operation | Default | Option |
| --- | --- | --- |
| UI clicks, inputs, panel controls | 30 seconds | `--action-timeout-seconds` |
| Startup/navigation, report queries, export readiness, download start | 120 seconds | `--step-timeout-seconds` |
| File transfer | 15 minutes | `--timeout-minutes` |

There is no whole-run timeout. A stalled browser step closes its session and
retries the **same report**, retaining hourly/monthly mode. Default recovery is
three attempts with 5-second and 10-second waits. Set `--attempts N` (1–10) to
change it. Errors, authentication failures, rate limits, and timeouts are never
treated as no-data signals. Exhausted attempts fail the run with status 1;
Ctrl+C exits with status 130. Bounds, limits, or confirmed no data finish normally.

Report responses are buffered through Playwright's routing API and delivered
unchanged to the UI. This avoids the reproduced Chromium missing-response-body
failure after downloads without adding duplicate report queries. Responses are
matched to both their requested period and granularity (`By day` versus `By month`).

Each exporter-generated log line has a local timestamp with UTC offset. Normal
success is one brief line; consecutive skips are summarized:

```text
2026-10-23T19:49:38.787+03:00 [INFO] Exported 2026-06 (daily yields)
2026-10-23T19:50:12.964+03:00 [INFO] Skipping through 2026-05 because 2 months already have valid CSVs.
```

Long steps emit warnings every 30 seconds showing their date/month, step,
elapsed time, and deadline. Retry diagnostics use safe failure codes and stages.

```sh
npm run export:reports -- --monthly-only --max-months 3 --headed
npm run export:reports -- --step-timeout-seconds 180 --attempts 5
npm run export:reports -- --help
```

## InfluxDB: single-day verification import

The importer uses daily totals from the **monthly CSVs** in `exports/134568461/daily/`.
Each selected calendar day produces **one point with one numeric field**,
`yield_kwh`, taken directly from that day's `PV Yield (kWh)` column. It does not
sum the monthly report, use hourly files, or import the cumulative `Total Yield`
counter. A blank daily yield is imported as **0**. Dates absent from the report
are rejected rather than invented.

Set these values locally in `report_exporter/.env`:

- `INFLUX_URL`: InfluxDB base URL (InfluxDB v2 write API).
- `INFLUX_TOKEN`: write token.
- `INFLUX_ORG`: organization.
- `INFLUX_BUCKET`: target bucket.
- `INFLUX_MEASUREMENT`: requested measurement, `energy-daily`.
- `INFLUX_TAGS`: requested tags, `device:solar,location:autotalli`.

All six are loaded at runtime. The importer never prints these settings, tokens,
URLs, raw HTTP errors, or server response bodies. It does not need FusionSolar
credentials or a browser.

```sh
# Preview CSV value and timestamp; no .env loading and no database request.
npm run influx:import -- --date 2023-05-01 --dry-run

# Write exactly this one day. No bulk mode or automatic write retries.
npm run influx:import -- --date 2023-05-01
```

Timestamps are **midnight in Europe/Helsinki**, the plant's local day. The
verification point for **2023-05-01** has value **32.64 kWh** and UTC timestamp
**2023-04-30T21:00:00Z** (May 1 at 00:00 +03:00). This single point was accepted
by InfluxDB with **HTTP 204**. No other dates have been imported by the agent;
the import is paused for user verification before adding bulk import.

The command requires one explicit `--date` and sends one line-protocol point in
one POST. Repeating the same date with the same measurement/tags updates the
same point rather than creating another timestamp. The timeout is 30 seconds.

## Verification

Only bounded live trials have been run by the coding agent:

- Monthly-only **June and May 2026**: two reports saved with 30 and 31 daily rows;
  totals independently summed to **865.66 kWh** and **898.14 kWh**.
- The same monthly range again: both skipped, with no browser login or download.
- Automatic handoff at **2025-07-20**: confirmed no hourly data, switched to
  **By month**, then downloaded **July and June 2025** in the same browser session.
- Monthly-only **October 2021**: confirmed no data and stopped without visiting
  the next requested month or writing an empty CSV.
- Earlier hourly regression: 10 new days exported in one session, with all
  2,640 hourly CSV cells checked against their XLSX sources. Measured pace was
  4.88 seconds per daily hourly-report export (about 12.3 reports/minute).

Offline tests cover automatic phase transitions, independent resume markers,
hourly/monthly bounds and limits, month/year/DST boundaries, calendar validity,
complete-versus-partial CSVs, current-period refresh, successful-conversion cleanup, failed/partial reports,
timeouts, retry cancellation, and concise timestamped logging.

```sh
npm test                 # sequential lightweight tests; no browser or .env
npm run test:browser     # optional local Chromium regression, no FusionSolar login
```
