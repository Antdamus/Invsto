# Step 5F.6S.4 Long-Running Workflow Reconciliation

Completion date: 2026-06-07

Scope: stabilization only. No Read/Unread Sync, Return Messaging, Live Sync, sending changes, mailbox architecture changes, or pagination redesign were implemented.

## Findings

- Reclassify Recent 100 mutated durable classification rows one conversation at a time, but the operator-visible completion event was written only after the whole loop returned.
- Browser aborts used `AbortController`, so the UI could lose the Edge Function response while the Edge Function continued writing durable database state.
- Backfill already had durable `ebay_message_sync_runs` and checkpoints, but classification failures inside a successful ingest were surfaced as generic warning/progress events.
- The dashboard did not have a first-class classification batch run source; it depended on activity events that could be stale or incomplete.

## Root Causes

- Classification batches had no durable run table with progress counters.
- Completion evidence for Reclassify Recent 100 was coupled to end-of-request activity event insertion.
- Timeout recovery refreshed broad mailbox/dashboard state, but did not prefer a durable run row because none existed for classification.
- Backfill status overloaded `warning` for the distinct state "sync succeeded, classification partially failed."

## What Changed

- Added `public.ebay_conversation_classification_runs` with:
  - `run_id`
  - `status`
  - `started_at`
  - `completed_at`
  - `requested_limit`
  - `processed_count`
  - `classified_count`
  - `failed_count`
  - `skipped_count`
  - `remaining_unclassified`
- Supported classification run statuses:
  - `pending`
  - `running`
  - `succeeded`
  - `partial_success`
  - `failed`
- Added database-triggered activity events for classification batch start and terminal completion.
- Stamped batch-created classifications with `validation_metadata.classification_run_id`.
- Updated Reclassify Recent 100 and Classify Unclassified to update durable run progress during the loop, not only after completion.
- Added `partial_success` to operational activity event statuses.
- Updated Backfill + Classify New events to report partial success when ingest succeeds but one or more classifications fail.
- Added dashboard classification-run reads and a "Latest Classification Batch" panel.
- Updated timeout recovery to query durable sync/classification run state before rendering final operator copy.
- Updated the Playwright harness to validate durable runs/events when the browser response times out.
- Bumped `email-triage.html` asset query strings to `5f6s4-20260607`.

## Validation Performed

Passed:

```sh
node --check email-triage.js
node --check email-triage.api.js
node --check email-triage.diagnostics.js
node --check tests/email-triage/email-triage-regression.spec.mjs
node --check tests/email-triage/supabase-readonly-checks.mjs
git diff --check -- email-triage.js email-triage.api.js email-triage.diagnostics.js email-triage.html supabase/functions/ebay-conversation-classify/index.ts supabase/functions/ebay-message-sync/index.ts supabase/migrations/20260607120000_email_triage_long_running_workflow_reconciliation.sql tests/email-triage docs/email-triage/STEP_5F6S4_LONG_RUNNING_WORKFLOW_RECONCILIATION.md
```

Local static smoke:

```text
Served the app on http://127.0.0.1:4183/email-triage.html.
Confirmed updated assets loaded with v=5f6s4-20260607.
Unauthenticated flow redirected to index.html?next=email-triage.html with no captured page errors.
```

Attempted but not completed locally:

```sh
deno check supabase/functions/ebay-conversation-classify/index.ts
deno check supabase/functions/ebay-message-sync/index.ts
```

Result: `deno` is not installed in this local environment.

```sh
node_modules/supabase/bin/supabase db lint
```

Result: local Postgres was not running on `127.0.0.1:54322`.

Live Playwright was not run in this implementation pass because it requires deployed migration/functions and authenticated live operational access.

## Remaining Risks

- If the Edge Function is terminated between an individual classification insert and the next run-progress update, the run can lag by one conversation until later reconciliation work.
- Dashboard convergence requires the migration to be deployed before the updated frontend and Edge Functions.
- Historical pre-5F.6S.4 pending events are not backfilled into the new run table.
- Full Deno type-check and Supabase migration lint still need to run in an environment with Deno and local/remote database access.

## Beta Readiness Estimate

Beta readiness estimate after this step: 72%.

Reason: the main operator-trust failure mode now has durable state, dashboard convergence, and harness coverage, but live deployment validation is still required before raising readiness further.

## Exact Deployment Requirements

Migration required: yes

Edge Function deploy required: yes

Frontend deploy required: yes

Run in this order:

```sh
node_modules/supabase/bin/supabase db push
node_modules/supabase/bin/supabase functions deploy ebay-conversation-classify
node_modules/supabase/bin/supabase functions deploy ebay-message-sync
```

Frontend files that must be published by the existing static-site deployment process:

```text
email-triage.html
email-triage.js
email-triage.api.js
email-triage.diagnostics.js
```

No frontend production deploy command is defined in `package.json`. Local verification command:

```sh
npm run serve:email-triage
```

Post-deploy validation commands:

```sh
npm run test:email-triage
EMAIL_TRIAGE_RUN_RECLASSIFY_RECENT=true npm run test:email-triage
EMAIL_TRIAGE_RUN_BACKFILL_CLASSIFY_NEW=true npm run test:email-triage
```

## Manual Verification Checklist

- Open `email-triage.html` after frontend deployment and confirm assets include `v=5f6s4-20260607`.
- Refresh the operational dashboard and confirm the "Latest Classification Batch" panel renders.
- Run Reclassify Recent 100.
- If the browser request times out, refresh the dashboard and confirm the durable run shows classified/skipped/failed/remaining counts.
- Confirm a started event exists for the run.
- Confirm a completed event exists once the run reaches `succeeded`, `partial_success`, or `failed`.
- Run Backfill + Classify New.
- Confirm `ebay_message_sync_runs.status` is `succeeded` for successful ingest.
- Confirm the dashboard event is `partial_success` when classifications include both successes and failures.
- Confirm mailbox canonical total and dashboard canonical total converge after refresh.

5F.6S.4 completed.
