# Step 5F.6S.4 Post-Deploy Validation

Date: 2026-06-07

Scope: post-deploy validation of Step 5F.6S.4 long-running workflow reconciliation only.

Explicitly not run:

- Backfill + Reclassify All
- Read/Unread Sync
- Return Messaging
- Live Sync
- Send workflows or eBay mutation workflows

## Deployment Confirmation

Remote migration confirmed applied:

```text
20260607120000_email_triage_long_running_workflow_reconciliation.sql
```

Required Edge Functions confirmed ACTIVE:

```text
ebay-conversation-classify
ebay-message-sync
```

Frontend asset query version confirmed on all local email triage CSS/JS assets loaded by `email-triage.html`:

```text
v=5f6s4-20260607
```

Note: the non-loading metadata tag still says `5f6s1-20260607`; this did not affect the loaded asset URLs but should be cleaned up as frontend hygiene.

## Validation Runs

Baseline:

```sh
npm run test:email-triage
```

Result: process passed.

Report:

```text
tests/email-triage/reports/email-triage-regression-2026-06-07T06-11-48-713Z.md
```

Reclassify Recent 100:

```sh
EMAIL_TRIAGE_RUN_RECLASSIFY_RECENT=true npm run test:email-triage
```

Result: process passed, but product validation failed for terminal reconciliation.

Report:

```text
tests/email-triage/reports/email-triage-regression-2026-06-07T06-15-34-124Z.md
```

Backfill + Classify New:

```sh
EMAIL_TRIAGE_RUN_BACKFILL_CLASSIFY_NEW=true npm run test:email-triage
```

Result: process passed.

Report:

```text
tests/email-triage/reports/email-triage-regression-2026-06-07T06-19-59-102Z.md
```

## Pass/Fail Summary

Overall Step 5F.6S.4 post-deploy validation: FAIL.

Passed:

- Baseline canonical mailbox RPC and UI count matching.
- Search behavior against canonical RPC.
- Smart folder behavior against canonical RPC.
- Selected timeline message persistence visibility.
- Dashboard rendering and refresh.
- Backfill + Classify New durable sync run.
- Backfill + Classify New dashboard/mailbox convergence.
- Send/eBay mutation safety checks.

Failed:

- Reclassify Recent 100 did not converge to a terminal durable run state after browser timeout.
- Reclassify Recent 100 did not create a completed event for the new run.
- Dashboard still shows the latest classification batch as `Running`, not completed successfully, after refresh.

## Reclassify Recent 100 Findings

Run ID:

```text
09999962-9ac9-496e-b854-3d3f3e21a156
```

Started event:

```text
01b2b897-8879-4a6f-b7aa-4b5de65b207f
Classification Batch Started
status: pending
```

Completed event:

```text
missing
```

Report-time snapshot:

```text
browserResponseTimedOut: true
status: running
processed_count: 78
classified_count: 78
failed_count: 0
skipped_count: 0
remaining_unclassified: 0
completed_at: null
classificationsForRun: 78
```

Post-report read-only reconciliation check:

```text
status: running
processed_count: 86
attempted_count: 86
classified_count: 86
failed_count: 0
skipped_count: 0
remaining_unclassified: 0
completed_at: null
classificationsForRun: 86
```

Operator dashboard after manual refresh:

```text
Latest Classification Batch
Running
Lifecycle status: Running
Run id: 09999962
Mode: Reclassify Recent 100
Completed: --
Processed: 86
Classified: 86
Failed: 0
Skipped: 0
Remaining unclassified: 0
```

Assessment:

The database work happened and durable progress counters improved, but the terminal lifecycle still did not reconcile. This is the core operator-trust failure mode from Step 5F.6S.3, narrowed to terminalization rather than total loss of evidence.

## Backfill + Classify New Findings

Run ID:

```text
c84eed70-a498-4068-baac-e072a10ee23a
```

Events:

```text
20212bec-ea7e-477f-a8fb-06dffc8f011a - Backfill Started - pending
5df23640-ed52-4a82-bb50-845e79f1f997 - Backfill Progress - succeeded
```

Counters:

```text
browserResponseTimedOut: false
run status: succeeded
canonicalBefore: 389
canonicalAfter: 413
pagesFetched: 2
conversationsSeen: 50
conversationsInserted: 24
conversationsUpdated: 0
conversationsUnchanged: 26
messagesSeen: 122
messagesInserted: 96
messagesUpdated: 0
messagesRechecked: 26
classificationProcessed: 24
classificationSucceeded: 24
classificationFailed: 0
classificationSkipped: 26
errors: 0
warningsCount: 0
```

Checkpoint state:

```text
FROM_MEMBERS: paused, pages_processed 11, next_offset 275, pages_remaining 62
FROM_EBAY: paused, pages_processed 6, next_offset 150, pages_remaining 399
Aggregate: 17 / 478 pages, 461 pages remaining, 425 conversations imported, 1009 messages imported
```

Assessment:

Backfill + Classify New reported truthfully as `succeeded`. This run did not exercise `partial_success` because no classifications failed.

## Counter Convergence

Current mailbox UI:

```text
Canonical: 413
Matching: 413
Unread: 0
Unclassified: 0
```

Current canonical RPC:

```text
canonical_total: 413
matching_total: 413
unread: 0
unclassified: 0
```

Current dashboard:

```text
Total canonical: 413
Unread conversations: 0
Unclassified: 0
Historical backfill conversations: 425
Historical backfill messages: 1009
```

Assessment:

Mailbox canonical total, dashboard total, RPC total, and unclassified count converge after Backfill + Classify New.

## Requested Audit Answers

1. Which checks passed:
   Baseline checks passed. Backfill + Classify New passed. Reclassify Recent 100 process passed but product validation failed terminal reconciliation.

2. Whether Reclassify Recent 100 now creates durable started/completed run evidence:
   No. It creates started run/event evidence and durable progress counters, but the run remains `running` and no completed event exists.

3. Whether dashboard shows the Latest Classification Batch correctly:
   No. It shows accurate counters but incorrect terminal lifecycle: `Running`, `Completed --`.

4. Whether Backfill + Classify New now reports success or partial_success truthfully:
   Yes. It reported `succeeded`, which matches 24 succeeded classifications and 0 failed classifications.

5. Whether mailbox canonical total and dashboard total converge:
   Yes. Both show 413 after the backfill run.

6. Whether unclassified count converges between UI/RPC/dashboard:
   Yes. UI, RPC, and dashboard all show 0 unclassified.

7. Whether any browser timeout still occurs:
   Yes. Reclassify Recent 100 still timed out waiting for the browser response. Backfill + Classify New did not time out.

8. Whether any stale pending event remains:
   Yes. The Reclassify Recent 100 started event remains pending without a matching completion event.

9. Whether any send/eBay mutation was attempted:
   No. Reports show `Blocked send attempts: 0`; Backfill + Classify New safety reported `ebayMutationsPerformed: false`, `sendsEnabled: false`, and `messagesSent: 0`.

10. Whether this is enough to mark 5F.6S.4 validated:
    No. The backfill path is validated, but the reclassify terminal lifecycle is still not operator-safe.

## Remaining Issues

- `ebay-conversation-classify` can leave a Reclassify Recent 100 run in `running` after browser timeout even when classifications were created.
- The completed activity event is missing for the timed-out reclassify run.
- The dashboard cannot truthfully show completion because the durable run itself is not terminal.
- Historical pending events from earlier pre-validation runs remain visible in the recent events list.

## Exact Next Recommendation

Do not mark Step 5F.6S.4 validated yet.

Fix only the Reclassify Recent 100 terminalization path:

- Ensure the classification Edge Function always finalizes the run when durable work has stopped.
- Set `status`, `completed_at`, `duration_ms`, `processed_count`, `classified_count`, `failed_count`, `skipped_count`, and `remaining_unclassified` in a terminal update.
- Write a `Classification Run Completed` event with the same `run_id`.
- Preserve truthful status:
  - `succeeded` when classified/skipped work completes with 0 failures.
  - `partial_success` when at least one classification succeeds and at least one fails.
  - `failed` when no classifications succeed and failures occur.
- Rerun only the bounded reclassify validation before broader beta audit work.

## Deployment Requirements

For the validation performed here:

```text
Migration required: no
Edge Function deploy required: no
Frontend deploy required: no
```

For the required follow-up fix:

```text
Migration required: no, assuming the existing 20260607120000 run table remains sufficient.
Edge Function deploy required: yes, ebay-conversation-classify.
Frontend deploy required: no for the current blocker.
```

Deploy command after the reclassify terminalization fix:

```sh
node_modules/supabase/bin/supabase functions deploy ebay-conversation-classify
```

Validation commands after that deploy:

```sh
npm run test:email-triage
EMAIL_TRIAGE_RUN_RECLASSIFY_RECENT=true npm run test:email-triage
```

Do not run:

```sh
EMAIL_TRIAGE_RUN_BACKFILL_RECLASSIFY_ALL=true npm run test:email-triage
```

## Manual Verification Checklist

- Refresh `email-triage.html`.
- Open Operations Dashboard.
- Click Refresh Dashboard.
- Confirm Latest Classification Batch shows a terminal lifecycle status.
- Confirm the latest Reclassify Recent 100 run has a completed timestamp.
- Confirm Processed equals Classified + Failed + Skipped.
- Confirm a `Classification Run Completed` event exists for the same run ID.
- Confirm mailbox Canonical, RPC canonical_total, and dashboard Total canonical match.
- Confirm UI/RPC/dashboard Unclassified count match.
- Confirm no send attempts or eBay mutations are recorded.

## Beta Readiness Estimate

Updated beta readiness estimate: 68%.

Reason: Backfill + Classify New and mailbox/dashboard convergence improved materially, but the highest-risk reclassify timeout case still fails terminal operator truth. The previous 72% estimate should not be claimed until Reclassify Recent 100 produces terminal durable state and a completion event after timeout.

5F.6S.4 post-deploy validation completed.
