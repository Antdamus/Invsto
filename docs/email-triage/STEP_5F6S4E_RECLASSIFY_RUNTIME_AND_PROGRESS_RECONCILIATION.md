# Step 5F.6S.4E - Reclassify Runtime And Progress Reconciliation

Date: 2026-06-07

## Executive Summary

Fail / blocked for final beta sign-off.

Implementation is locally complete, but live write-path validation could not be completed because the local Supabase CLI is not authenticated:

```text
Access token not provided. Supply an access token by running supabase login or setting the SUPABASE_ACCESS_TOKEN environment variable.
```

The code now changes the active maintenance workflow from `Reclassify Recent 100` to `Reclassify Recent 20`, adds a runtime budget, writes a truthful `reclassify_recent_20` run mode, and tightens Playwright so reconciliation rescue no longer counts as a pass.

## Root Cause

`Reclassify Recent 100` was still too large for an operator-triggered request.

The latest failed evidence showed 81 processed conversations taking 616,513 ms, or about 7.6 seconds per conversation. At that rate, 100 sequential OpenAI classification calls naturally exceeds a normal operator validation window. The durable run row eventually reconciled correctly, but normal completion still depended on delayed stale-run reconciliation after the browser workflow had already lost trust.

Audit conclusions:

- 100 is not an appropriate default maintenance batch size for beta.
- A smaller default is the simplest fix because reclassify is maintenance; `Classify Unclassified` remains the daily workflow.
- Chunking/continuation is not required for beta if the maintenance scope is bounded to 20 and the function terminalizes itself.
- A background model would add more lifecycle surface than this beta workflow needs.
- The dashboard/activity mismatch came from immutable started events carrying initial zero counters while the run row had live progress.

## What Changed

- Frontend button copy and tooltip now say `Reclassify recent 20`.
- Forced recent reclassification now sends a fixed limit of 20.
- Edge Function force mode clamps requested limit to 20.
- Durable run mode is now `reclassify_recent_20`; legacy `reclassify_recent_100` rows remain valid.
- Forced reclassify gets a 240,000 ms per-invocation runtime budget.
- If the runtime budget is reached before all 20 candidates are processed, the run terminalizes as `partial_success` with `runtime_budget_exhausted` and `remaining_candidate_count`.
- Final terminal run writes now use the required/retried update path.
- Dashboard normalization enriches the active started activity row from the current run row while the run is pending/running, so activity counters and the Latest Classification Batch panel agree.
- Frontend asset version bumped to `5f6s4e-20260607`.
- Playwright now expects `reclassify_recent_20`, requested limit <= 20, and explicitly fails if the browser request times out and needs reconciliation rescue.

## Validation Evidence

Local static checks passed:

```text
node --check email-triage.api.js
node --check email-triage.js
node --check tests/email-triage/email-triage-regression.spec.mjs
git diff --check -- email-triage.api.js email-triage.html email-triage.js supabase/functions/ebay-conversation-classify/index.ts supabase/migrations/20260607190000_email_triage_reclassify_recent_20_budget.sql tests/email-triage/email-triage-regression.spec.mjs tests/email-triage/regression-report-template.md tests/email-triage/README.md
```

Local read-only Playwright passed:

```text
npm run test:email-triage
2 passed (36.8s)
Report: tests/email-triage/reports/email-triage-regression-2026-06-07T19-18-56-773Z.md
```

Evidence from that report:

```text
Canonical total: 430
Loaded: 100
Unclassified: 0
Returns: 104
Dashboard rendered
Blocked send attempts: 0
Reclassify recent 20: skipped because write flag was not enabled
```

Validation blocked:

- `node_modules/supabase/bin/supabase db lint` could not run because local Postgres was not running at `127.0.0.1:54322`.
- `deno check` could not run because Deno is not installed.
- `node_modules/supabase/bin/supabase db push --yes` could not run because Supabase deploy auth is missing.
- Live Reclassify Recent 20 Playwright write validation was not run because the migration and Edge Function could not be deployed first.

## Beta Readiness

Beta readiness remains:

```text
78%
```

The implementation addresses the active design issue, but beta readiness should not be raised until deployed write-path evidence proves:

- `reclassify_recent_20` runs terminalize without reconciliation rescue.
- The banner, dashboard run row, and activity events agree.
- No stale pending/running lifecycle remains after the validation window.

## Remaining Blockers

- Supabase deployment authentication is missing on this machine.
- Migration is not deployed.
- `ebay-conversation-classify` Edge Function is not deployed.
- Production/static frontend deploy process is still outside `package.json`.
- Live write-path Playwright for Reclassify Recent 20 has not passed yet.

## Deployment Requirements

```text
Migration required? Yes.
Edge Function deploy required? Yes.
Frontend deploy required? Yes.
```

Exact backend commands:

```sh
node_modules/supabase/bin/supabase db push --yes
node_modules/supabase/bin/supabase functions deploy ebay-conversation-classify --project-ref byhytmarmigalvawkedi
```

Frontend files that must be published by the existing static-site deployment process:

```text
email-triage.html
email-triage.api.js
email-triage.js
```

No frontend production deploy command is defined in `package.json`.

Post-deploy validation command:

```sh
EMAIL_TRIAGE_RUN_RECLASSIFY_RECENT=true npm run test:email-triage
```

Optional broader post-deploy validation:

```sh
EMAIL_TRIAGE_RUN_CLASSIFY_UNCLASSIFIED=true \
EMAIL_TRIAGE_RUN_RECLASSIFY_RECENT=true \
npm run test:email-triage
```

## Exact Next Step

Do not move to `5F.6P - Live Sync + Read/Unread Synchronization` yet.

Exact next step:

```text
Deploy 5F.6S.4E migration/function/frontend, then run Reclassify Recent 20 Playwright write validation.
```

After that validation passes with no stale running lifecycle and no delayed reconciliation dependency, move to:

```text
5F.6P - Live Sync + Read/Unread Synchronization
```
