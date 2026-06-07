# Step 5F.6S.4A Reclassify Terminalization Fix

Completion date: 2026-06-07

Scope: Reclassify Recent 100 terminalization lifecycle only. No Read/Unread Sync, Return Messaging, Live Sync, mailbox RPC architecture, pagination architecture, sending workflow, or AI behavior changes were made.

## Root Cause

Reclassify Recent 100 could outlive the browser request and then hit the practical Edge Function runtime ceiling. The function updated progress rows during the loop, but if execution stopped after progress updates and before a terminal update, the durable run stayed `running`, `completed_at` stayed null, and the database trigger had no terminal status transition to emit a completion event.

The first stabilization pass also made the Playwright check too permissive: it accepted `running`, so the harness could miss the operator-trust failure.

## Fix Implemented

- Hardened `supabase/functions/ebay-conversation-classify/index.ts` so terminal run updates are required, retried, and no longer silently swallowed.
- Preserved partial counters in unexpected exception paths instead of replacing progress with a single generic failure.
- Added `public.reconcile_ebay_conversation_classification_runs(_stale_after_seconds integer)` in `20260607143000_email_triage_reclassify_terminalization_fix.sql`.
- Dashboard refresh and the Edge Function now reconcile stale open classification runs after 90 seconds without progress.
- Updated the classification run activity trigger titles:
  - `Classification Run Completed`
  - `Classification Run Partial Success`
  - `Classification Run Failed`
- Added explicit dashboard fields for `Terminal Status` and `Duration`.
- Tightened Playwright validation to require terminal status, `completed_at`, exactly one terminal event, dashboard agreement, no stale open run, and zero send attempts.

## Validation

Passed local checks:

```sh
node --check email-triage.api.js
node --check email-triage.diagnostics.js
node --check tests/email-triage/email-triage-regression.spec.mjs
node --check tests/email-triage/supabase-readonly-checks.mjs
git diff --check
```

Deployed:

```sh
node_modules/supabase/bin/supabase db push --yes
node_modules/supabase/bin/supabase functions deploy ebay-conversation-classify --project-ref byhytmarmigalvawkedi
```

Final live validation passed:

```sh
EMAIL_TRIAGE_RUN_RECLASSIFY_RECENT=true npm run test:email-triage
```

Result: `2 passed (5.3m)`.

## Run IDs Tested

- `b30cad3e-3ad8-467b-81c8-dbff9195c89d`: final passing Playwright run. Status `partial_success`; started `2026-06-07T15:57:18.327396+00:00`; completed `2026-06-07T16:02:08.160687+00:00`; processed `79`; classified `79`; failed `0`; skipped `0`; duration `289833 ms`.
- `091227f7-a512-47bd-b269-3767104ce458`: validation iteration terminalized by reconciliation. Status `partial_success`; processed `76`; classified `76`; failed `0`.
- `9c295400-c35d-4808-8d3d-559f67b48272`: original tightened-test failure reproduced the issue, then terminalized by reconciliation. Status `partial_success`; processed `68`; classified `65`; failed `3`.

Final open-run check after reconciliation returned `[]` for `status in (pending,running)`.

## Dashboard Evidence

For final run `b30cad3e-3ad8-467b-81c8-dbff9195c89d`, the dashboard rendered:

- Latest Classification Batch: `Partial Success`
- Terminal Status: `Partial Success`
- Run ID: `b30cad3e...`
- Started: `Jun 07, 2026, 11:57 AM`
- Completed: `Jun 07, 2026, 12:02 PM`
- Duration: `289833 ms`
- Processed: `79`
- Classified: `79`
- Failed: `0`
- Skipped: `0`
- Remaining Unclassified: `0`

Activity timeline showed exactly the expected pair for the final run:

- `Classification Batch Started`
- `Classification Run Partial Success`

## Playwright Evidence

Report: `tests/email-triage/reports/email-triage-regression-2026-06-07T16-02-10-841Z.md`

Key assertions passed:

- Durable run reached terminal status: `partial_success`.
- `completed_at` was populated.
- Exactly one terminal activity event existed: `Classification Run Partial Success`.
- Dashboard terminal status matched the run table.
- `classificationsForRun` equaled `classified_count` (`79`).
- `sendAttemptsCreated` was `0`.
- `Blocked send attempts` was `0`.

## Remaining Risks

- Reclassify Recent 100 can still exceed the Edge Function runtime before all 100 candidates complete; this is now represented as terminal `partial_success` instead of stale `running`.
- The 90-second stale-progress window assumes individual classifier calls should not remain silent beyond the 45-second OpenAI timeout plus persistence overhead.
- Production static frontend publishing is still outside `package.json`; local Playwright validated the updated frontend files against the deployed backend.

## Updated Beta Readiness Estimate

Beta readiness estimate after Step 5F.6S.4A: 78%.

Reason: the highest-priority operator-trust blocker is now closed with deployed backend changes and live Playwright evidence. Remaining readiness risk is mostly broader beta surface area outside this stabilization step, especially production static deploy discipline and non-classification workflows.
