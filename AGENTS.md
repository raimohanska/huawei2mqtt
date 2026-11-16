# Repository agent instructions

- Commit task changes when they are ready and relevant checks pass, unless the
  user asks otherwise. Review the staged changes for secrets and unrelated user
  work before committing. Do not push unless the user requests it.
- Keep all Playwright extraction, report-processing, and InfluxDB import code
  under `report_exporter/`.
- **LLMs and coding agents must never read `.env` files or their contents.**
  This applies to `.env` and credential-bearing `.env.*` files anywhere in the
  project, including through shell commands, search tools, browser automation,
  subprocess output, or debugging. `.env.example` may contain placeholders only.
- The user manages FusionSolar and InfluxDB credentials locally in
  `report_exporter/.env`.
  Application code may load those credentials at runtime, but must never print
  them, include them in errors, or expose them in agent-visible output.
- Do not capture login-page screenshots, traces, recordings, or DOM snapshots
  containing credentials. Keep saved browser authentication under
  `report_exporter/.playwright/` and downloaded reports under
  `report_exporter/exports/`; these paths are ignored by Git.
