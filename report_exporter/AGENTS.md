# Report exporter agent instructions

- Keep all Playwright extraction and report-processing code in this directory.
- **LLMs and coding agents must never read `.env` files or their contents.**
  This applies to `.env` and credential-bearing `.env.*` files anywhere in the
  project, including through shell commands, search tools, browser automation,
  subprocess output, or debugging. `.env.example` may contain placeholders only.
- The user manages the FusionSolar username and password locally in `.env`.
  Application code may load those credentials at runtime, but must never print
  them, include them in errors, or expose them in agent-visible output.
- Do not capture login-page screenshots, traces, recordings, or DOM snapshots
  containing credentials. Keep saved browser authentication under `.playwright/`
  and downloaded reports under `exports/`; these paths are ignored by Git.
