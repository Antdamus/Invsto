# Step 5F.6S.4D - Final Workflow Validation & Sync Banner/Dashboard Reconciliation

Validation date: 2026-06-07

Scope: validation and reporting only. No production code, migrations, Edge Functions, frontend assets, eBay sends, or eBay mutations were changed in this step. Live validation did run Sync Recent Mailbox, Refresh Timeline, Classify Unclassified, and Reclassify Recent 100 against the deployed backend and local `v=5f6s4-20260607` frontend assets.

Required prior documents read completely:

- `docs/email-triage/STEP_5F6S_COMPREHENSIVE_REGRESSION_AUDIT.md`
- `docs/email-triage/STEP_5F6S3_HIGH_RISK_WORKFLOW_VALIDATION.md`
- `docs/email-triage/STEP_5F6S4_LONG_RUNNING_WORKFLOW_RECONCILIATION.md`
- `docs/email-triage/STEP_5F6S4A_RECLASSIFY_TERMINALIZATION_FIX.md`
- `docs/email-triage/STEP_5F6S4B_SYNC_RECENT_DEEP_VALIDATION.md`
- `docs/email-triage/STEP_5F6S4C_SYNC_RECENT_CORRECTNESS_REPAIR.md`

Primary evidence:

- Live write harness: `tests/email-triage/reports/email-triage-regression-2026-06-07T18-47-19-280Z.md`
- Final read-only harness: `tests/email-triage/reports/email-triage-regression-2026-06-07T18-55-58-929Z.md`
- Failed Playwright artifact: `test-results/email-triage-regression-em-75ad2-nticated-regression-harness-chromium/error-context.md`
- Follow-up DB reconciliation query at `2026-06-07T18:54:30.484Z`

Commands run:

```sh
env EMAIL_TRIAGE_RUN_SYNC_RECENT=true EMAIL_TRIAGE_RUN_REFRESH_TIMELINE=true EMAIL_TRIAGE_RUN_CLASSIFY_UNCLASSIFIED=true EMAIL_TRIAGE_RUN_RECLASSIFY_RECENT=true EMAIL_TRIAGE_RUN_BACKFILL_ARCHIVE=false EMAIL_TRIAGE_RUN_BACKFILL_CLASSIFY_NEW=false EMAIL_TRIAGE_RUN_BACKFILL_RECLASSIFY_ALL=false EMAIL_TRIAGE_SYNC_RECENT_TARGET_EBAY_CONVERSATION_ID=124850576707 EMAIL_TRIAGE_SYNC_RECENT_TARGET_CONVERSATION_TYPE=FROM_MEMBERS EMAIL_TRIAGE_EXPECT_SYNC_RECENT_TARGET_SWEEP=true npm run test:email-triage
npm run test:email-triage
```

The first sandboxed Playwright attempt failed before validation because the sandbox blocked the local HTTP server from binding to `127.0.0.1:4173`. The same harness was rerun outside the sandbox. All live browser routes continued to block send attempts; both reports recorded `Blocked send attempts: 0`.

## Executive Summary

| Area | Result | Summary |
| --- | --- | --- |
| Sync Recent | Pass | Run `130dae7e-3679-4910-aeeb-8d1f9832b46c` inserted 1 conversation and 2 messages, swept the known Rafa conversation, updated durable state, and matched banner/dashboard/activity counts. |
| Refresh Timeline | Pass | Run `c9ed44ea-2ed6-4df7-9aa9-e5e76f004695` rechecked the selected conversation directly and preserved the already-current 30-message timeline. |
| Classify Unclassified | Pass | Run `115ec18d-d598-4e86-9f62-0fa12083d41b` classified 17 of 17 unclassified conversations and reduced unclassified count from 17 to 0. |
| Reclassify Recent 100 | Fail | Run `f162d35d-d9e1-4008-ad9b-194f1b9bc469` remained `running` when Playwright hit its 6-minute test timeout; it terminalized later by reconciliation as `partial_success` after 616,513 ms. |
| Dashboard | Pass with reclassify caveat | Mailbox/dashboard canonical counts converged to 430 and unclassified 0. The dashboard eventually showed the terminal reclassify event, but not within the live workflow window. |
| Mailbox | Pass | UI, canonical RPC, search, smart folders, and selected timeline persistence matched. Final mailbox: canonical 430, members 275, eBay notifications 155, unread 11, unclassified 0. |
| Activity Events | Fail for active reclassify | Sync and classify terminal events were truthful. During reclassify, Recent eBay Activity still showed only the started event with 0 counters while the run table/dashboard panel showed durable progress. |
| Sync Banners | Pass for sync workflows | The observed green `0/0` Sync Recent banner was not reproduced. Playwright asserted the banner contained `102` conversations, `538` messages scanned, and `2` messages inserted from the live response. |

Bottom line:

```text
Sync Recent correctness and sync banner reporting pass on current deployed code/assets.
The remaining beta blocker is Reclassify Recent 100 lifecycle/runtime truth, not Sync Recent data correctness.
```

## Workflow Evidence

| Workflow | Durable work performed | Mailbox shows | Dashboard shows | Activity events show | Banner shows |
| --- | --- | --- | --- | --- | --- |
| Sync Recent | Run `130dae7e`: 2 provider pages, 102 conversations seen, 1 conversation inserted, 1 conversation updated, 100 unchanged, 538 messages scanned, 2 inserted, 536 rechecked, 100 canonical detail sweep refreshes. Rafa `124850576707` was swept, not provider-list processed, and advanced from 29 to 30 messages. | Canonical total advanced to 430; selected Rafa timeline later showed 30 messages. | Latest Sync succeeded; conversations scanned 102, inserted 1, changed 1, messages scanned 538, inserted 2, changed 0, canonical after sync 430. | `Sync Recent Mailbox Completed` at `2026-06-07T18:42:53.410254Z` with detail: saw 102 conversations, scanned 538 messages, rechecked 536, changed 0, canonical sweep refreshed 100. | Harness passed banner assertion against the live response. The banner did not show `0/0`; it reflected 102 conversations and 538 messages scanned. |
| Refresh Timeline | Run `c9ed44ea`: targeted `124850576707`, 1 conversation seen, 30 messages scanned, 30 rechecked, 0 inserted/changed. | Selected timeline remained at 30 messages, which matched canonical storage. | Refresh did not change total counts; dashboard remained consistent with canonical total 430. | Two `conversation_synced` events for the selected conversation appeared around `18:43Z`. | Harness passed banner assertion: 1 conversation, 30 messages scanned, 0 inserted. |
| Classify Unclassified | Run `115ec18d`: 17 candidates examined, 17 classified, 0 failed, 0 skipped; unclassified 17 -> 0. | Final mailbox smart count unclassified 0. | Dashboard canonical count 430 and unclassified 0 after refresh. | Started event at `18:43:22Z`; terminal `Classification Run Completed` at `18:44:04Z`. | Classification result banner reported 17 examined/classified and 0 remaining unclassified. |
| Reclassify Recent 100 | Run `f162d35d`: requested 100, target 100. At Playwright failure dashboard showed 72 processed, 71 classified, 1 failed, still running. Follow-up reconciliation terminalized at 81 processed, 80 classified, 1 failed, 0 skipped. | Final mailbox remained consistent: canonical 430, unclassified 0. | During validation: Latest Classification Batch was Running. After delayed reconciliation: partial success terminal event appeared. | During validation: only `Classification Batch Started` was available in Recent eBay Activity with 0 examined/classified. After follow-up reconciliation: `Classification Run Partial Success` appeared. | The harness failed before a terminal reclassify banner could be validated. This is the active blocker. |

## Findings

### 1. Reclassify Recent 100 Still Exceeds The Operator Validation Window

Root cause:

Reclassify Recent 100 still performs sequential OpenAI classification calls for up to 100 conversations inside one browser-triggered Edge Function request. The function updates the durable run row after each conversation, but terminal status is written only after the loop completes, throws, reaches the target count, or becomes stale enough for `reconcile_ebay_conversation_classification_runs(...)` to close it.

In this run, progress was still recent enough that harness reconciliation did not terminalize it before the overall Playwright timeout. The run later terminalized through reconciliation at `2026-06-07T18:54:27.060317Z` as `partial_success`.

Evidence:

```text
Run id: f162d35d-d9e1-4008-ad9b-194f1b9bc469
Started: 2026-06-07T18:44:10.546776Z
Playwright failure: received durable status "running"
Dashboard at failure: 72 processed, 71 classified, 1 failed, terminal status --
Terminalized: 2026-06-07T18:54:27.060317Z
Final status: partial_success
Final counters: 81 processed, 80 classified, 1 failed, 0 skipped
Duration: 616,513 ms
Terminalized by: reconcile_ebay_conversation_classification_runs
```

Severity:

```text
High
```

Operator impact:

An operator can click Reclassify Recent 100, see durable progress, but still not receive terminal closure for many minutes. This is much better than the original stale `running` forever failure, but it is still not beta-safe because the workflow does not close inside the active browser validation window.

Recommended fix:

Move Reclassify Recent 100 to a time-budgeted durable chunk model. Each browser action should return quickly with a run id, process only a bounded time/candidate chunk, and poll the run until terminal or explicitly `paused/continue_required`. A run should never depend on "eventual stale reconciliation" for normal operator closure.

### 2. Activity Events Do Not Show Live Reclassify Progress Truth

Root cause:

The activity event trigger writes a started event at run insert and a terminal event only when the run status changes to `succeeded`, `partial_success`, or `failed`. Progress counters live in `ebay_conversation_classification_runs`, but the Recent eBay Activity event list does not enrich the started event from the current run row.

Evidence from the Playwright failure snapshot:

```text
Latest Classification Batch panel:
  status: Running
  processed: 72
  classified: 71
  failed: 1

Recent eBay Activity card:
  Classification Batch Started
  0 examined
  0 classified
  0 failed
  0 skipped
  Pending
```

Severity:

```text
High
```

Operator impact:

Two dashboard surfaces tell different stories while a long reclassify run is active. A careful operator can trust the Latest Classification Batch panel, but the activity feed still reads like no work has happened.

Recommended fix:

Either emit/upsert progress activity events during classification batches, or enrich the started activity card from the current `ebay_conversation_classification_runs` row when `eventRunId` matches an active run. The feed should show current processed/classified/failed/skipped counts while the run is pending/running.

### 3. Sync Recent Banner 0/0 Was Not Reproduced On Current Code

Root cause:

No current root cause was confirmed for the previously observed green `Conversations seen: 0 / Messages scanned: 0` banner. In the current deployed/local asset combination, the Edge Function response, banner assertion, dashboard latest sync panel, activity event, sync run row, and mailbox state agreed.

Evidence:

```text
Sync run: 130dae7e-3679-4910-aeeb-8d1f9832b46c
Response counters: conversationsSeen 102, messagesSeen 538, messagesInserted 2
Dashboard latest sync: conversations scanned 102, messages scanned 538
Activity detail: saw 102 conversations and scanned 538 messages
Mailbox final total: 430
Playwright banner assertion: passed
```

Severity:

```text
None for current Sync Recent direct-response path
```

Operator impact:

The specific reported Sync Recent green-banner mismatch appears fixed or not reproducible on current assets. There is still a small residual risk that a timeout/recovered sync path could surface different durable-run normalization, but this live run did not hit that path.

Recommended fix:

No immediate Sync Recent banner repair is required from this evidence. For clarity, a future copy polish should add explicit banner fields for canonical detail sweep candidates/refreshed/messages inserted, because activity events already expose those counters and the banner currently rolls them into aggregate scan counts.

## Count Reconciliation

Final read-only harness after delayed reclassify reconciliation:

```text
Report: tests/email-triage/reports/email-triage-regression-2026-06-07T18-55-58-929Z.md
Result: 2 passed
Canonical total: 430
Matching total: 430
Loaded: 100
Displayed: 100
Members: 275
eBay notifications: 155
Unread: 11
Unclassified: 0
Returns: 104
Selected timeline messages: 30
```

Follow-up DB/RPC query at `2026-06-07T18:54:30.484Z`:

```text
Canonical total: 430
Matching total: 430
Unclassified: 0
Returns: 104
Needs reply today: 263
Refund risk: 161
Review queue: 356
```

These agree for the core mailbox/dashboard surfaces validated in this step.

## Beta Readiness

Beta is not ready now.

Exact blocker:

```text
Reclassify Recent 100 still does not produce timely terminal operator closure.
It can durably classify many conversations, remain running past the browser/test workflow window,
and only terminalize later through stale-run reconciliation.
```

Updated beta completion estimate:

```text
78%
```

Reason:

Sync Recent, mailbox, timeline, dashboard counts, Classify Unclassified, and sync banners are materially stronger than before 5F.6S.4C. The remaining blocker is narrower than the earlier inbox correctness gap, but it is still an operator-trust failure in a visible beta workflow.

## Deployment Requirements

For this 5F.6S.4D validation/reporting step:

```text
Migration required: No
Edge Function deploy required: No
Frontend deploy required: No
```

For the recommended stabilization fix:

```text
Migration required: Likely yes, if adding first-class progress/paused continuation state or progress activity upserts.
Edge Function deploy required: Yes, for reclassify chunk/time-budget behavior.
Frontend deploy required: Yes, for polling/continue UX and activity/banner reconciliation.
Harness update required: Yes, to validate chunked terminal or continue-required semantics.
```

## Exact Next Step

Do not move to `5F.6P - Live Sync + Read/Unread Synchronization` yet.

Create one consolidated stabilization step:

```text
5F.6S.4E - Reclassify Recent 100 Runtime Budget, Progress Events, and Banner Reconciliation
```

Required scope:

1. Add a hard per-invocation runtime/candidate budget for Reclassify Recent 100.
2. Return quickly with a durable run id and explicit state: `running`, `partial_success`, `paused`, `continue_required`, `succeeded`, or `failed`.
3. Persist current progress in a way both the Latest Classification Batch panel and Recent eBay Activity feed render identically.
4. Make the reclassify banner poll durable run state instead of waiting for one long browser function response.
5. Update Playwright so the validation passes when the operator-visible state is truthful: terminal if complete, or `continue_required/paused` with exact processed/classified/failed/skipped counts if the bounded chunk stops early.

After 5F.6S.4E passes live validation, the system should be safe to move to:

```text
5F.6P - Live Sync + Read/Unread Synchronization
```

