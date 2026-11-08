# Slotbook — Automated browser UAT (Windows, no Docker)

This is a Playwright Chromium test suite for the **actual React UI** and HTTP API. It tests against an **isolated** backend on `http://127.0.0.1:3101`, using the dedicated `slotbook_ts_test` PostgreSQL database. Your normal `localhost:3000` server can keep running. The launcher refuses to connect to `slotbook_ts`.

## One-command run

Copy the supplied `run-e2e.ps1`, `playwright.config.mjs`, `scripts/start-e2e.mjs` and `tests/e2e/slotbook.spec.mjs` into the **existing** `Slotbook_TypeScript_Assignment` folder, retaining relative paths. Then run from PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\run-e2e.ps1
```

Prerequisites: a working `.env` with separate `DATABASE_URL=.../slotbook_ts` and `TEST_DATABASE_URL=.../slotbook_ts_test`; Node 22+; local PostgreSQL. The script checks `.env`, installs the Playwright test package and Chromium (first run requires internet), builds the app and runs browser tests. It does **not** overwrite `package.json`, `.env` or your database.

The isolated test server runs migration/seed **without truncation**. Tests create synthetic bookings and cancel active ones after use; cancelled booking and outbox audit rows remain **only in the test database**. Do **not** run `npm run test:local` simultaneously; its test suite truncates the same test database.

## Test cases

1. Responsive mobile menu, host login, workspace tabs, logout and page refresh.
2. Guest slot selection, 5-minute hold, release and reavailability.
3. Guest hold/confirm, private URL in a fresh browser context (without host login), reschedule (same booking ID and incremented version), cancel, reopened capacity, host dashboard and outbox notifications.
4. Group event: five concurrent seat requests for capacity four, exactly four succeed and one receives conflict.

On failures, see `playwright-report/index.html`, `test-results/` screenshots and traces. These can include private test booking links, so do not publish raw artifacts. Never paste `.env` or private tokens into a public report.

## Known limits

- This does not test actual email delivery (only transactionally stored notification outbox).
- Five-minute expiration is tested by existing PostgreSQL integration tests, rather than waiting five minutes in the browser suite.
- The browser test still needs to run on your Windows machine to validate local Chromium/PostgreSQL integration. Script syntax can be statically verified independently; do not treat that as a passing browser run.
