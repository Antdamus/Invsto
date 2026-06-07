# Step 5F.6S.3 High-Risk Workflow Validation

Validation date: 2026-06-07

Scope: live Playwright harness validation of high-risk eBay email-triage workflows only. No production behavior, migrations, Edge Functions, frontend code, deployments, eBay sends, eBay mutations, or Backfill + Reclassify All runs were performed.

Source-of-truth documents read first:

- `docs/email-triage/STEP_5F6S_COMPREHENSIVE_REGRESSION_AUDIT.md`
- `docs/email-triage/STEP_5F6S2_LIVE_REGRESSION_TEST_HARNESS.md`

Primary harness artifacts:

- `tests/email-triage/reports/email-triage-regression-2026-06-07T05-10-41-785Z.md`
- `tests/email-triage/reports/email-triage-regression-2026-06-07T05-20-35-880Z.md`
- `tests/email-triage/reports/email-triage-regression-2026-06-07T05-22-39-013Z.md`

Commands run:

```sh
EMAIL_TRIAGE_RUN_SYNC_RECENT=true EMAIL_TRIAGE_RUN_REFRESH_TIMELINE=true EMAIL_TRIAGE_RUN_CLASSIFY_UNCLASSIFIED=true EMAIL_TRIAGE_RUN_RECLASSIFY_RECENT=true EMAIL_TRIAGE_RUN_BACKFILL_CLASSIFY_NEW=true npm run test:email-triage
EMAIL_TRIAGE_RUN_BACKFILL_CLASSIFY_NEW=true npm run test:email-triage
npm run test:email-triage
```

Explicitly not run:

- Backfill + Reclassify All
- Controlled Send
- Return Messaging
- Any eBay mutation
- Any send operation

All harness reports recorded `Blocked send attempts: 0`. Function safety envelopes for sync/classification/backfill recorded no eBay mutation and no sends.

## Executive Summary

| Workflow | Result | Summary |
| --- | --- | --- |
| Sync Recent Mailbox | Pass | Completed with run `eb0f155f-f0d5-4f08-9995-eb95ed907f78`; UI, RPC, sync run, and dashboard counters matched. No new provider conversations were present in the latest-sync scope. |
| Refresh Timeline | Pass | Completed with run `8001c86c-d691-43b3-83de-d159dc86381e`; selected conversation timeline remained persistent and unchanged as expected. |
| Classify Unclassified | Pass, no-op path | Completed with event `c7567990-ad7d-4fae-bd82-476a5164dca6`; unclassified count was 0 before and after, so no classification candidates existed. |
| Reclassify Recent 100 | Fail | Browser-visible response timed out. Durable DB writes show only 86 conversations reclassified, while dashboard retained only a pending started event with 0 examined/0 classified. |
| Backfill + Classify New | Fail for operator trust, pass for durable ingest/classify | Durable sync run `74d47d62-f057-4ade-beb9-477cf805242b` succeeded and inserted/classified new data, but the browser-visible harness timed out waiting for the function response. |
| Dashboard Consistency | Fail | Final manual refresh showed correct counts, but timeout workflows left stale/pending or warning events that do not truthfully summarize the durable work performed. |

Answer to the primary question:

```text
Sync -> Display -> Classification -> Dashboard does not yet work reliably enough
for new conversations without operator confusion.
```

The durable backend can ingest and classify new conversations. The operator-facing workflow is not reliable because long-running classification/backfill actions can time out or lose the browser-visible response while durable state changes continue.

Beta readiness estimate:

```text
64%
```

This is down from the previous 68% estimate because live validation confirmed operator-trust failures in two high-risk workflows, not just theoretical risks.

## Evidence

### Baseline Before Live Actions

From `email-triage-regression-2026-06-07T05-10-41-785Z.md`:

```text
App loaded at: 2026-06-07T05:07:20.458Z
Canonical total: 364
Matching total: 364
Loaded count: 100
Members: 224
eBay notifications: 140
Unread: 0
Unclassified: 0
Returns: 86
Selected conversation DB id: 4cb9f064-4c97-43bd-a273-84af85352b6f
Selected eBay conversation/message id: 207982197719
Selected timeline messages: 1
```

Search evidence:

```text
Search term: 207982197719
Expected RPC matching total: 1
UI matching total: 1
```

Smart folder evidence:

```text
Folder: Returns
Expected RPC matching total: 86
UI matching total: 86
```

### Sync Recent Mailbox

Run id:

```text
eb0f155f-f0d5-4f08-9995-eb95ed907f78
```

Request:

```json
{
  "runType": "incremental",
  "conversationTypes": ["FROM_MEMBERS", "FROM_EBAY"],
  "conversationPageLimit": 25,
  "messagePageLimit": 25,
  "maxConversationPages": 1,
  "classificationMode": "none",
  "checkpointScope": "commerce_message_latest_sync",
  "latestSyncLookbackDays": 14,
  "readOnly": true
}
```

Counters:

```text
Pages fetched: 2
Conversations seen: 1
New conversations inserted: 0
Existing conversations updated: 0
Conversations unchanged: 1
Messages seen: 1
Messages inserted: 0
Messages changed: 0
Messages rechecked: 1
Canonical after sync: 364
Unclassified before: 0
Unclassified after: 0
```

Dashboard/DB reconciliation:

```text
message_sync_completed event: 17cf94a3-8d38-4e9c-a0d6-a7c4ccb7c592
sync run status: succeeded
dashboard latest sync status after final refresh: SUCCEEDED
dashboard conversations scanned: 1
dashboard messages scanned: 1
dashboard messages rechecked: 1
dashboard messages inserted: 0
dashboard messages changed: 0
latest-sync FROM_EBAY checkpoint last_run_id: eb0f155f-f0d5-4f08-9995-eb95ed907f78
latest-sync FROM_MEMBERS checkpoint last_run_id: eb0f155f-f0d5-4f08-9995-eb95ed907f78
```

Result:

```text
Sync Recent did not discover new conversations in this run because the provider latest scope returned one already-known eBay notification conversation.
It did correctly recheck the existing message and kept UI/DB counters aligned.
```

### Refresh Timeline

Run id:

```text
8001c86c-d691-43b3-83de-d159dc86381e
```

Request:

```json
{
  "runType": "manual",
  "conversationTypes": ["FROM_EBAY"],
  "conversationPageLimit": 1,
  "messagePageLimit": 50,
  "maxConversationPages": 1,
  "maxDetailPagesPerConversation": 20,
  "classificationMode": "none",
  "readOnly": true,
  "conversationId": "207982197719"
}
```

Counters:

```text
Pages fetched: 0
Conversations seen: 1
New conversations inserted: 0
Existing conversations updated: 0
Messages seen: 1
Messages inserted: 0
Messages changed: 0
Messages rechecked: 1
Canonical after refresh: 364
```

Timeline persistence:

```text
Before message count: 1
After message count: 1
Before latest message id: 207982197719
After latest message id: 207982197719
Before latest timestamp: 2026-06-07T03:29:02+00:00
After latest timestamp: 2026-06-07T03:29:02+00:00
UI timeline rows: 1
```

When Refresh Timeline updates something Sync Recent misses:

```text
Refresh Timeline uses a targeted conversationId request with larger detail paging.
It can update a selected conversation when that conversation is outside the latest-sync page/window or needs targeted message-detail paging.
In this run, the selected conversation was also the latest-sync conversation, so Refresh Timeline correctly found no extra delta.
```

### Classify Unclassified

Activity event ids:

```text
Started: 2eb07862-d2b1-4eeb-bd35-0b126bb4718d
Completed: c7567990-ad7d-4fae-bd82-476a5164dca6
```

Request:

```json
{
  "mode": "classify_recent",
  "limit": 100,
  "force": false
}
```

Counters:

```text
Run mode: classify_unclassified_conversations
Queue source: get_ebay_canonical_mailbox_v2:unclassified
Canonical queue: unclassified
Initial unclassified count: 0
Candidates examined: 0
Actually classified: 0
Skipped: 0
Failed: 0
Remaining unclassified: 0
Duration: 1124 ms
```

Count agreement:

```text
Mailbox UI unclassified before run: 0
RPC unclassified before run: 0
Function unclassified_before: 0
Function unclassified_after: 0
Dashboard unclassified after final refresh: 1
RPC unclassified after final backfill: 1
Mailbox UI unclassified after final refresh: 1
```

The final unclassified count changed to 1 only after Backfill + Classify New imported 25 additional conversations and one classification failed. Classify Unclassified itself had a true no-op queue.

### Reclassify Recent 100

Harness outcome:

```text
Playwright timeout: page.waitForResponse timed out after 180000 ms
Failing line: tests/email-triage/email-triage-regression.spec.mjs:526
Blocked send attempts: 0
```

Started event:

```text
Event id: 588a15ef-4f4e-4864-9008-0cd74190f421
Created at: 2026-06-07T05:07:42.579102+00:00
Status: pending
Title: Classification Batch Started
Detail: Reclassify Recent 100 started. Requested bounded limit: 100; current unclassified before run: 0.
```

Durable DB writes after browser timeout:

```text
Query time: 2026-06-07T05:14:46.159Z
Classification rows created since start: 86
Unique conversations reclassified: 86
Current rows created: 86
Old rows superseded: 86
First classification created: 2026-06-07T05:07:45.338202+00:00
Last classification created: 2026-06-07T05:11:00.95957+00:00
Completion event found: no
```

Scope validation:

```text
Requested bounded limit: 100
Durable classifications completed: 86
Observed durable scope did not equal the requested recent 100.
No archive-wide reclassification was observed from this run.
```

Operator-facing mismatch:

```text
Dashboard showed the reclassify run as pending with 0 examined / 0 classified / 0 failed / 0 skipped.
Database showed 86 current classifications created after that pending event.
No completed or failed aggregate event reconciled the run by the final dashboard refresh.
```

### Backfill + Classify New

Harness outcome:

```text
Playwright timeout: page.waitForResponse timed out after 300000 ms
Failing line: tests/email-triage/email-triage-regression.spec.mjs:568
Blocked send attempts: 0
```

Durable sync run:

```text
Run id: 74d47d62-f057-4ade-beb9-477cf805242b
Run type: backfill
Status: succeeded
Started at: 2026-06-07T05:15:36.503563+00:00
Completed at: 2026-06-07T05:18:06.813+00:00
Classification mode: classify_new
```

Counters:

```text
Pages fetched: 2
Conversations seen: 50
Conversations succeeded: 50
Conversations unchanged: 25
Messages seen: 121
Messages inserted: 96
Messages changed: 0
Messages rechecked: 25
Classification processed: 25
Classification succeeded: 24
Classification failed: 1
Classification skipped: 25
Canonical total before: 364
Canonical total after: 389
New canonical conversations inserted: 25
Unclassified after: 1
```

Backfill checkpoint evidence:

```text
FROM_MEMBERS checkpoint:
  status: paused
  last_run_id: 74d47d62-f057-4ade-beb9-477cf805242b
  next_offset: 250
  total_available: 1803
  pages_processed: 10
  conversations_processed: 250
  messages_processed: 762

FROM_EBAY checkpoint:
  status: paused
  last_run_id: 74d47d62-f057-4ade-beb9-477cf805242b
  next_offset: 125
  total_available: 10103
  pages_processed: 5
  conversations_processed: 125
  messages_processed: 125
```

Classify-new scope validation:

```text
Classification rows updated since 2026-06-07T05:15:35Z: 24
Rows created in that window: 24
Old classification rows updated in that window: 0
```

This supports that Backfill + Classify New classified only newly imported/unclassified conversations and avoided reclassifying already-classified rows in this run.

Activity events:

```text
Started event: 387d1a37-d218-4323-9d25-1d1c6c4d219d
Progress event: 6ee5a6b9-862a-409e-b962-fe69b84822ce
Progress event status: warning
Progress detail: Historical eBay message backfill chunk completed. Processed 50 conversations and 121 messages; resume from checkpoint for the next chunk.
```

The run succeeded durably but the progress event was warning because one classification failed. The browser-visible response did not reach the harness before timeout.

### Final Post-Action UI/RPC/Dashboard Counts

Final read-only Playwright report:

```text
Report: email-triage-regression-2026-06-07T05-22-39-013Z.md
Result: 2 passed
```

Mailbox UI and RPC:

```text
Canonical: 389
Matching: 389
Loaded: 100
Displayed: 100
Members: 249
eBay notifications: 140
Unread: 0
Unclassified: 1
Returns: 91
Smart folder selected by harness: Unclassified
Unclassified matching total: 1
```

Dashboard DOM extraction after manual refresh:

```text
Dashboard refreshed: Jun 07, 2026, 1:24 AM
Total canonical: 389
Unclassified: 1
Latest sync lifecycle status: SUCCEEDED
Latest sync conversations scanned: 1
Latest sync messages scanned: 1
Latest sync messages rechecked: 1
Latest sync messages inserted: 0
Latest sync messages changed: 0
Backfill status: Paused
Backfill pages: 15
Backfill conversations: 375
Backfill messages: 887
```

Final count agreement:

```text
Mailbox UI canonical total: 389
RPC canonical total: 389
Dashboard total canonical: 389

Mailbox UI unclassified total: 1
RPC unclassified total: 1
Dashboard unclassified total: 1
```

Final dashboard consistency issue:

```text
Dashboard still showed Reclassify Recent 100 only as a pending started event,
even though 86 classification rows were durably written by that invocation.
```

## Findings

### 1. Reclassify Recent 100 Can Partially Mutate Classification State Without Completion Evidence

Root cause:

```text
The batch classification path is a synchronous browser Edge Function request with a 90 second frontend abort timer.
The function records a durable "started" event before entering the per-conversation loop, but records the completed aggregate event only after the whole loop finishes.
When the browser request timed out, classification writes continued long enough to create 86 new current rows and supersede 86 old rows, but no completed or failed aggregate event was recorded.
The UI timeout reconciliation found only the pending started event and therefore displayed 0 examined / 0 classified while the database was changing.
```

Severity:

```text
High
```

Operator impact:

```text
An operator can believe Reclassify Recent 100 did not classify anything, while the database has already reclassified 86 conversations.
The workflow also failed the "scope really equals recent 100" trust requirement because the durable effect stopped at 86.
```

Recommended fix:

```text
Move batch classification to a durable job/run model or shorten the default batch size below the client timeout.
Persist progress counters during the loop, not only at start/completion.
On timeout, reconcile from durable progress rows and mark partial completion/failure truthfully.
Do not show a pending started event as 0 examined/0 classified once row-level classifications exist.
```

### 2. Backfill + Classify New Completes Durably But Browser Workflow Times Out

Root cause:

```text
The backfill workflow is also a long synchronous browser Edge Function request.
The durable sync run completed successfully in about 150 seconds, but Playwright did not observe the browser-visible function response before the 300 second wait expired.
The backend had the truth in ebay_message_sync_runs, checkpoints, and backfill activity events; the browser workflow did not reliably surface that truth to the operator during the action.
```

Severity:

```text
High
```

Operator impact:

```text
An operator can see the action time out even though new conversations/messages were ingested and 24 of 25 new conversations were classified.
The next manual dashboard refresh shows updated totals, but the original action path does not reliably close the loop.
```

Recommended fix:

```text
Treat backfill chunks as queued/durable operations with an immediate accepted response and a visible run id.
Poll sync run/checkpoint state until completion, timeout, or partial failure.
Show both sync status and classification sub-status: succeeded sync run, 24 classified, 1 failed, 1 remaining unclassified.
```

### 3. Dashboard Event Semantics Are Not Internally Truthful Enough For Timed-Out Workflows

Root cause:

```text
The dashboard is reading durable events correctly, but some workflows write incomplete lifecycle events.
Reclassify writes a started event but no completed/failed event after partial durable writes.
Backfill writes a progress warning event for a sync run whose status is succeeded because classification had one failure.
```

Severity:

```text
High
```

Operator impact:

```text
The dashboard can contain enough raw facts to investigate, but not enough synthesized truth for quick operator trust.
Operators must mentally reconcile pending classification events, succeeded sync runs, warning progress events, and changed mailbox counts.
```

Recommended fix:

```text
Add explicit lifecycle states for partial_success and completed_with_classification_failures.
Surface run id, final counters, and remaining unclassified in the dashboard event card.
Add a reconciliation job/check that closes stale pending classification events when row-level evidence proves partial work happened.
```

### 4. Sync Recent Did Not Prove New-Conversation Discovery In This Run

Root cause:

```text
The provider latest-sync scope returned only one already-known eBay notification conversation.
This is valid behavior, but it means Sync Recent itself did not exercise the "new conversation inserted" path.
Backfill + Classify New did exercise new ingestion.
```

Severity:

```text
Medium
```

Operator impact:

```text
Sync Recent appears trustworthy for no-delta/latest-window rechecks, but this specific run cannot prove it will discover a provider-new conversation when one appears in the latest window.
```

Recommended fix:

```text
Add a repeatable fixture or controlled provider test condition where one known new conversation appears in latest-sync scope.
Until then, document that this validation proves no-delta correctness for Sync Recent and new-ingestion correctness for Backfill + Classify New.
```

## Beta Readiness Update

Updated beta completion estimate:

```text
64%
```

Working, validated:

- Admin login and current frontend assets loaded.
- Canonical mailbox RPC counts match UI.
- Search matches canonical RPC.
- Smart folders match canonical RPC.
- Selected timeline message persistence is visible.
- Sync Recent no-delta recheck path is internally consistent.
- Refresh Timeline no-delta targeted path is internally consistent.
- Classify Unclassified canonical empty-queue path is truthful.
- Backfill + Classify New durably ingests new conversations/messages.
- Backfill + Classify New classifies only new/unclassified rows in the observed run.
- No sends or eBay mutations occurred.

Remaining blockers:

- Reclassify Recent 100 can partially reclassify rows after browser timeout without a truthful completion event.
- Backfill + Classify New can succeed durably but fail the browser-visible workflow.
- Dashboard lifecycle copy/status is not yet trustworthy for timeout/partial-success cases.
- Sync Recent still needs a live positive test where a provider-new latest conversation is actually available.
- Classify Unclassified still needs a positive test with real unclassified candidates; this run only validated the zero-candidate path.

## Final Decision

The system can durably ingest, display, classify, and report new conversations at the database/read-model level.

It cannot yet do so without operator confusion.

The next step should be a targeted stabilization pass for long-running workflow lifecycle handling:

```text
1. Durable run/progress model for Reclassify Recent 100.
2. Durable polling/reconciliation model for Backfill + Classify New.
3. Dashboard event semantics for partial success, timeout, and stale pending events.
4. Repeatable positive fixtures for Sync Recent new-conversation discovery and Classify Unclassified non-empty queues.
```
