# Step 5F.6S.2 Live Regression Test Harness

## Permission / Access Audit

1. Playwright can run `email-triage.html` as an authenticated admin.
   The login page uses Supabase Auth email/password and then checks `employees.role = admin` plus `employees.active = true`. The harness supports either admin credentials for setup or a saved Playwright storage state.

2. Required local env vars:
   `EMAIL_TRIAGE_BASE_URL`, plus either `EMAIL_TRIAGE_ADMIN_EMAIL` and `EMAIL_TRIAGE_ADMIN_PASSWORD` or `EMAIL_TRIAGE_STORAGE_STATE`.
   `SUPABASE_URL` and `SUPABASE_ANON_KEY` are optional because the page exposes the configured frontend anon client at runtime.

3. Supabase anon plus admin login is enough for normal validation.
   The canonical mailbox RPC, conversation/message tables, activity events, sync runs, and checkpoints grant authenticated select/execute behind staff/admin policies.

4. Service role is not required for the harness.
   It is only useful for local RLS debugging, or if an operator wants Node-side verification without relying on the browser admin session. If used, it must live only in `.env.local` or `.env.codex`.

5. The tests can safely avoid eBay mutations.
   `ebay-message-sync` refreshes OAuth and uses eBay GET requests for Commerce Message data. Classification calls OpenAI and writes Supabase classification/audit rows. Actual eBay sending lives in `ebay-conversation-draft` mode `send`, which the harness does not click and actively aborts if called from the browser.

6. `.env.local` / `.env.codex` structure:
   Use `tests/email-triage/.env.codex` for Codex-specific local credentials and `tests/email-triage/.env.local` for a developer's local defaults. Root `.env.local` and `.env.codex` are also read. Shell env vars override file values.

7. Gitignored files:
   Real `.env` files, Playwright storage state, reports, screenshots/videos/traces, and Playwright HTML output are ignored.

8. Exact commands:

```sh
npm install --save-dev @playwright/test
npx playwright install chromium
cp tests/email-triage/.env.example tests/email-triage/.env.codex
npm run test:email-triage
```

Optional live gates:

```sh
EMAIL_TRIAGE_RUN_SYNC_RECENT=true EMAIL_TRIAGE_RUN_REFRESH_TIMELINE=true npm run test:email-triage
EMAIL_TRIAGE_RUN_CLASSIFY_UNCLASSIFIED=true EMAIL_TRIAGE_RUN_RECLASSIFY_RECENT=true npm run test:email-triage
EMAIL_TRIAGE_RUN_BACKFILL_ARCHIVE=true npm run test:email-triage
EMAIL_TRIAGE_RUN_BACKFILL_CLASSIFY_NEW=true npm run test:email-triage
EMAIL_TRIAGE_RUN_BACKFILL_RECLASSIFY_ALL=true EMAIL_TRIAGE_CONFIRM_FULL_RECLASSIFY_ALL=I_UNDERSTAND_THIS_RECLASSIFIES_ARCHIVE npm run test:email-triage
```

## Harness Design

```text
tests/email-triage/
  README.md
  .env.example
  playwright.config.mjs
  email-triage-regression.spec.mjs
  supabase-readonly-checks.mjs
  regression-report-template.md
```

The harness:

- Opens the local app.
- Authenticates as admin or reuses `tests/email-triage/.auth/admin.json`.
- Captures request/response evidence for `ebay-message-sync`.
- Compares UI sync banner counters with Edge Function response counters.
- Queries Supabase REST read-only with the admin session token.
- Verifies canonical RPC counts, search, saved smart folders, dashboard events, and selected conversation message persistence.
- Optionally runs Sync recent mailbox, Refresh Timeline, Classify unclassified, Reclassify recent 100, Backfill archive, Backfill + classify new, and Backfill + reclassify all.
- Writes a markdown report under `tests/email-triage/reports/`.

## Safe Implementation Boundary

Changed files are limited to tests, docs, `.env.example`, `.gitignore`, and package scripts.

No app frontend behavior, Edge Function code, migrations, or production behavior changed.

## Local Secrets

Normal runs require only an admin login or storage state. Do not put service-role keys in frontend files. Do not commit any real `.env` file.

## Manual Verification Still Needed

- Human review of whether live classification/backfill count changes are acceptable for the active operations queue.
- Human confirmation if production eBay/Seller Hub state needs investigation.
- Human choice of which expensive live gates to run.

