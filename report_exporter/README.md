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
npm run export:reports -- --help
```

The default is **15 minutes per operation**, including navigation, report-query
waits, export-job readiness, and download transfers. `--timeout-minutes` adjusts
that limit. There is **no whole-run timeout**; a run can continue for hours.

The script logs in only when needed, opens this plant's Plant Report, selects
**By day** and **100 / page**, chooses the date in the calendar, and searches.
FusionSolar generates an export job in its **Tasks** panel; the script waits for
the matching day's download icon. All work is sequential.

## Skip/resume and no-data detection

- A completed daily XLSX is parsed and checked against its filename's date before
  skipping any browser query or download for that day. Its CSV is regenerated
  locally, including if missing after an interrupted run. If all dates in an
  explicit range already exist, no browser is opened and `.env` is not loaded.
- A corrupt or wrong-day workbook stops the run with an error rather than being
  silently skipped or overwritten.
- The observed **2021-10-22** no-data state has HTTP 200, `failCode: 0`,
  `success: false`, `message: null`, and an empty list with total zero. The script
  checks that response for the requested plant-local date, plus the UI's
  **No data**, **Total: 0**, and disabled **Export** button before stopping.
- Nonempty reports are not treated as the end of history, even if all their
  readings are missing or zero. Authentication errors, server errors, rate
  limits, and timeouts fail the run; they are not no-data signals.
- Stopping at the first empty day assumes that day marks the end of available
  contiguous history. To inspect dates before a gap, provide an earlier `--to`.
- Successful completion (date bounds, max-days, or no data) exits with status 0;
  errors exit with status 1, and an interrupted run exits with status 130.

## Output

Downloads are stored by plant and report date:

```text
exports/134568461/YYYY/MM/YYYY-MM-DD.xlsx
exports/134568461/YYYY/MM/YYYY-MM-DD.csv
```

Downloads use `.partial.xlsx` and `.partial.csv` filenames until the workbook is
parsed, its date is verified, and the hourly row count matches the report UI.
Only then are they renamed to the final filenames. Partial files do not count
as completed downloads. Today's file contains the hours available at export
time and, like other existing reports, is not automatically refreshed.

CSV conversion runs for both new and previously downloaded workbooks, so reruns
generate a missing CSV without downloading the XLSX again. The converter finds
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

Browser authentication persists in `.playwright/profile/`. Both `.playwright/`
and `exports/` are ignored by Git. Only run one exporter at a time with this
profile. If login requires additional verification, the script exits with a
generic error; use headed mode to inspect the browser.

## Verification performed

Only bounded live trials have been run; the full-history loop has not been run.

- **2026-10-22 through 2026-10-20:** skipped one existing day and downloaded the
  two missing days, with 24 hourly rows in each new XLSX/CSV.
- **The same three-day range again:** skipped all three, downloaded nothing,
  and did not open the browser.
- **2021-10-22 through 2021-10-21:** stopped after inspecting 2021-10-22, with no
  download and no attempt to visit the next date.
- **2022-11-05 through 2022-11-03:** also stopped on the initial no-data day.

Offline checks cover date bounds, leap days, month/year and Helsinki DST
boundaries, rejection of failed/partial report responses, and preservation of
zero/missing readings. Run them with:

```sh
npm test
```

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
