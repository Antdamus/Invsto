# Email Triage Live Regression Harness

This is a local, authenticated, audit-first Playwright harness for `email-triage.html`.

The default run opens the app, authenticates as an admin, validates canonical mailbox/search/folder behavior, checks selected-conversation message persistence, refreshes the dashboard, and writes a markdown evidence report. Live buttons that write Supabase sync/classification/read-model rows are opt-in through env flags.

## Safety

- The harness never needs a service-role key for normal runs.
- The browser uses the frontend anon key plus an authenticated admin session.
- Node-side verification uses Supabase REST with the same admin session token.
- Service role is only supported as an explicit local override for RLS debugging.
- The harness aborts any browser request to `ebay-conversation-draft` with `mode: "send"`.
- The harness also aborts any browser-visible request to `/commerce/message/v1/send_message`.
- No real `.env` file or storage state is committed.

## Local Setup

Install test-only dependencies:

```sh
npm install --save-dev @playwright/test
npx playwright install chromium
```

Create a local env file:

```sh
cp tests/email-triage/.env.example tests/email-triage/.env.codex
```

Set either:

```sh
EMAIL_TRIAGE_ADMIN_EMAIL=
EMAIL_TRIAGE_ADMIN_PASSWORD=
```

or point to an existing Playwright storage state:

```sh
EMAIL_TRIAGE_STORAGE_STATE=tests/email-triage/.auth/admin.json
```

## Commands

Read-only baseline:

```sh
npm run test:email-triage
```

Run recent sync and selected timeline refresh:

```sh
EMAIL_TRIAGE_RUN_SYNC_RECENT=true \
EMAIL_TRIAGE_RUN_REFRESH_TIMELINE=true \
npm run test:email-triage
```

Run bounded classification checks:

```sh
EMAIL_TRIAGE_RUN_CLASSIFY_UNCLASSIFIED=true \
EMAIL_TRIAGE_RUN_RECLASSIFY_RECENT=true \
npm run test:email-triage
```

Run one archive backfill chunk:

```sh
EMAIL_TRIAGE_RUN_BACKFILL_ARCHIVE=true npm run test:email-triage
```

Run one backfill + classify-new chunk:

```sh
EMAIL_TRIAGE_RUN_BACKFILL_CLASSIFY_NEW=true npm run test:email-triage
```

Run one full-archive reclassify chunk:

```sh
EMAIL_TRIAGE_RUN_BACKFILL_RECLASSIFY_ALL=true \
EMAIL_TRIAGE_CONFIRM_FULL_RECLASSIFY_ALL=I_UNDERSTAND_THIS_RECLASSIFIES_ARCHIVE \
npm run test:email-triage
```

## Output

Reports are written to:

```text
tests/email-triage/reports/
```

Playwright artifacts are written to ignored artifact folders under `tests/email-triage/`.

## What Requires Service Role?

Nothing in the normal harness. Service role is only useful if you intentionally want to verify data while bypassing RLS or without an admin browser session. Keep it only in `.env.local` or `.env.codex`.
