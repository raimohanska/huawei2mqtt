# FusionSolar report exporter

Local Playwright tooling for downloading daily FusionSolar reports. Requires
Node.js 20 or newer. Run these commands from `report_exporter/`.

## Setup

```sh
npm ci
npm run browser:install
```

## Inspect the report UI

Open your FusionSolar URL in a visible Chromium browser:

```sh
npm run browser:open -- "https://your-fusionsolar-host/"
```

Or open the recorder to inspect the daily-report workflow:

```sh
npm run browser:codegen -- "https://your-fusionsolar-host/"
```

Log in in the browser. Keep saved authentication state and persistent profiles
under `.playwright/`, and downloaded XLSX reports and processed CSV files under
`exports/` in this directory. Both directories are ignored by Git.

Credentials can be configured locally in `report_exporter/.env` (ignored by
Git). `AGENTS.md` explicitly forbids LLMs and coding agents from reading this
file or exposing its contents.

The daily batch-export script will be added after inspecting the actual report
UI. All extraction and report-processing code belongs in this directory.
