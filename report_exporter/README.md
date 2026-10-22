# FusionSolar report exporter

Local Playwright tooling for downloading daily FusionSolar reports. Requires
Node.js 22 or newer. Run these commands from `report_exporter/`.

## Setup

```sh
npm ci
npm run browser:install
```

## Export today

Configure these variables locally in `report_exporter/.env`:

- `HUAWEI_LOGIN_PAGE`: HTTPS login URL.
- `HUAWEI_USERNAME`: account username.
- `HUAWEI_PASSWORD`: account password.

The application loads `.env` at runtime; existing process environment values take
precedence. `AGENTS.md` forbids LLMs and coding agents from reading credential
files. Credentials and raw browser errors are never printed.

```sh
npm run export:today
# To watch the browser:
npm run export:today -- --headed
```

The script logs in, opens the configured plant's Plant Report, selects **By day**,
**100 / page**, and **Today**, searches, then exports. FusionSolar generates a
job in its **Tasks** panel; the script clicks that job's download icon when ready.
It exports only today and exits. Past-day traversal is not implemented yet.

Downloads are stored by plant and report date:

```text
exports/134568461/YYYY/MM/YYYY-MM-DD.xlsx
```

Files are downloaded to `.xlsx.partial`, checked for the XLSX ZIP signature, then
renamed to the final filename. Existing files with that signature are skipped;
this is only a basic archive check, not full workbook validation. Today's file
contains the hours available at export time and is not automatically refreshed.

Browser authentication persists in `.playwright/profile/`. Both `.playwright/`
and `exports/` are ignored by Git. Only run one exporter at a time with this
profile. If login requires additional verification, the script exits with a
generic error; use headed mode to inspect the browser.

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
