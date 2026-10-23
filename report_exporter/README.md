# FusionSolar report exporter

Local Playwright tooling for downloading daily FusionSolar reports. Requires
Node.js 22 or newer. Run these commands from `report_exporter/`.

## Setup

```sh
npm ci
npm run browser:install
```

## Credentials

Configure these variables locally in `report_exporter/.env`:

- `HUAWEI_LOGIN_PAGE`: HTTPS login URL.
- `HUAWEI_USERNAME`: account username.
- `HUAWEI_PASSWORD`: account password.

The application loads `.env` at runtime; existing process environment values take
precedence. `AGENTS.md` forbids LLMs and coding agents from reading credential
files. Credentials and raw browser errors are never printed.

## Run instructions

From the project root, enter this directory once:

```sh
cd report_exporter
```

### Full history

```sh
npm run export:reports
```

This starts at **today in FusionSolar**, works backwards one day at a time, skips
already-downloaded days, and stops at the **first confirmed no-data day**. Each
new download is converted to CSV before advancing. Re-run the same command to
resume; completed days will not be downloaded again. Press **Ctrl+C** to stop.
Already-running processes keep their loaded code. Restart your current run to
apply updated logging, timeouts, and CSV-only completion checks.

### Short trial / custom date range

Both dates are inclusive; `--from` is the oldest and `--to` is the newest. The
script always visits dates in descending order:

```sh
npm run export:reports -- --from 2026-10-20 --to 2026-10-22
```

Limit a run to at most three dates, starting today:

```sh
npm run export:reports -- --max-days 3
```

`--max-days` counts all visited dates, including skipped dates. An empty report
stops the run even if there are dates remaining within the requested range.
`--from` and `--to` can also be used individually; omitting `--to` starts today.

### Today only / visible browser / timeouts

```sh
npm run export:today
npm run export:reports -- --max-days 3 --headed
npm run export:reports -- --timeout-minutes 30
npm run export:reports -- --action-timeout-seconds 30 --step-timeout-seconds 120
npm run export:reports -- --max-days 50 --attempts 5
npm run export:reports -- --help
```

Timeouts distinguish quick UI actions from longer network operations:

| Operation | Default | Option |
| --- | --- | --- |
| UI clicks, inputs, closing panels | 30 seconds | `--action-timeout-seconds` |
| Browser startup/navigation, report queries, export readiness, download start | 120 seconds | `--step-timeout-seconds` |
| File transfer | 15 minutes | `--timeout-minutes` |

There is **no whole-run timeout**; a run can continue for hours. A stalled report
or export step closes the old browser and triggers recovery rather than leaving
its work running beside the next attempt. Long-running steps emit a timestamped
warning every 30 seconds naming the step, date, elapsed time, and deadline.

Transient failures are retried **up to three attempts per day** by default. Each
retry closes the browser, waits 5 seconds (then 10 seconds), logs in again, and
retries the **same date**. `--attempts N` changes the total attempts (1–10).
Attempts do not count as extra visited dates. Completed files are checked again
before retrying, so a failure after saving cannot cause a duplicate export.
Ctrl+C also cancels retry waits and closes a browser still logging in.

The script logs in only when needed, opens this plant's Plant Report, selects
**By day** and **100 / page**, chooses the date in the calendar, and searches.
FusionSolar generates an export job in its **Tasks** panel; the script waits for
the matching day's download icon. All work is sequential.

Report responses are buffered through Playwright's routing API and delivered
unchanged to the browser. This avoids the reproduced Chromium/Playwright
`Network.getResponseBody` missing-resource failure that otherwise occurred on
the report query after a download. The report request still originates from
the UI's Search action; buffering does not issue a second report query. The
buffering/fetch operation has the configured step timeout.

Every exporter-generated log line has a **local timestamp with UTC offset**.
A normally completed day produces exactly one brief success line. Consecutive
skipped days produce one summary, not one line per date:

```text
2026-10-23T23:15:04.123+03:00 [INFO] Skipping to 2026-10-16 because 6 days already have valid CSVs.
2026-10-23T23:15:09.456+03:00 [INFO] Exported 2026-10-16
```

Retries and stalled-step warnings include safe failure stage/codes and attempt
numbers. Logs never dump raw browser errors, response bodies, authentication
headers, or credentials.

## Skip/resume and no-data detection

- The **final daily CSV is the completion marker**. The script validates its
  headers, 1–25 hourly rows, date, column counts, and numeric/blank yield readings
  before skipping that day. XLSX files are not required. If all dates in an
  explicit range already have valid CSVs, no browser is opened and `.env` is not
  loaded.
- When revisiting old downloads, a valid CSV allows redundant XLSX files to be
  removed. If only an old XLSX exists, it is converted locally, the CSV validated
  and saved, and then the XLSX removed. This needs no FusionSolar query.
- Invalid or wrong-day CSVs stop the run rather than being silently overwritten.
  Their XLSX source is preserved. Partial files never count as completed days.
- The observed **2021-10-22** no-data state has HTTP 200, `failCode: 0`,
  `success: false`, `message: null`, and an empty list with total zero. The script
  checks that response for the requested plant-local date, plus the UI's
  **No data**, **Total: 0**, and disabled **Export** button before stopping.
- Nonempty reports are not treated as the end of history, even if all their
  readings are missing or zero. Authentication errors, server errors, rate
  limits, and timeouts trigger recovery and retry; they are not no-data signals.
  If all attempts fail, the run stops with an error and keeps completed files.
- Stopping at the first empty day assumes that day marks the end of available
  contiguous history. To inspect dates before a gap, provide an earlier `--to`.
- Successful completion (date bounds, max-days, or no data) exits with status 0;
  errors exit with status 1, and an interrupted run exits with status 130.

## Output

Downloads are stored by plant and report date:

```text
exports/134568461/YYYY/MM/YYYY-MM-DD.csv
```

Downloads first use a temporary `.partial.xlsx`. The workbook is parsed and
converted to `.csv.partial`; the CSV's date, structure, and hourly row count are
checked against the report. The final CSV is published by atomic rename, then
the XLSX is deleted. Failed conversions retain their XLSX source and do not
publish a completion CSV. Today's CSV contains the hours available at export
time and, like other existing reports, is not automatically refreshed.

CSV conversion runs for new downloads and legacy XLSX-only days. The converter finds
the plant report table, omits its decorative title row and empty worksheets,
trims column headers, and preserves all report columns and hourly data. Missing
readings remain blank, real zeros remain zero, and timestamp text (including
`DST`) is kept as exported. Output is UTF-8 with comma separators, standard CSV
quoting, and CRLF line endings, saved atomically via `.csv.partial`. Conversion
checks that the workbook contains hourly rows matching the selected date.

To convert an existing download without opening the browser or loading `.env`:

```sh
npm run convert:csv -- exports/134568461/2026/10/2026-10-22.xlsx
```

This standalone conversion also deletes the XLSX only after successfully
validating and saving its CSV.

Browser authentication persists in `.playwright/profile/`. Both `.playwright/`
and `exports/` are ignored by Git. Only run one exporter at a time with this
profile. If login requires additional verification, the script exits with a
credential-safe diagnostic after exhausting its attempts; use headed mode to
inspect the browser.

## Verification performed

Only bounded live trials have been run; the full-history loop has not been run.

- **Post-fix 10-day trial, 2026-10-12 through 2026-10-03:** downloaded and
  converted **10 new days in one browser session**, all on their first attempt.
  All 2,640 hourly CSV cells were independently checked against the XLSX files.
- **The same 10-day range again:** skipped all 10, with no browser login or
  duplicate downloads.
- Measured steady-state pace from that trial: **4.88 seconds/day**, approximately
  **12.3 reports/minute**. Three years at that pace is approximately 89 minutes,
  excluding login and any retries; allow around 1.5–2 hours.
- **2026-10-22 through 2026-10-20:** skipped one existing day and downloaded the
  two missing days, with 24 hourly rows in each new XLSX/CSV.
- **The same three-day range again:** skipped all three, downloaded nothing,
  and did not open the browser.
- **2021-10-22 through 2021-10-21:** stopped after inspecting 2021-10-22, with no
  download and no attempt to visit the next date; rechecked after the buffering
  fix and retry changes.
- **2022-11-05 through 2022-11-03:** also stopped on the initial no-data day.

Lightweight tests cover CSV-only skipping, legacy migration, deletion only after
successful conversion, invalid/partial CSVs, timestamps and batched skip logs,
date/DST boundaries, report errors, retry limits/backoff/cancellation, and
stalled-step cancellation followed by a fresh successful attempt. These tests
run sequentially, do not launch a browser, and never load `.env`:

```sh
npm test
```

The optional local Chromium regression test checks report capture before and
after a file download, without duplicate queries or access to FusionSolar:

```sh
npm run test:browser
```

The CSV-only/logging/deadline updates were checked offline while the user's
exporter was already running; no second live exporter was started.

## Inspect the report UI manually

Open your FusionSolar URL in a visible Chromium browser:

```sh
npm run browser:open -- "https://your-fusionsolar-host/"
```

Or open the recorder to inspect the daily-report workflow:

```sh
npm run browser:codegen -- "https://your-fusionsolar-host/"
```

These manual commands do not load `.env`; log in directly in the browser. Do not
save recordings or other artifacts containing credentials. All extraction and
report-processing code belongs in this directory.
