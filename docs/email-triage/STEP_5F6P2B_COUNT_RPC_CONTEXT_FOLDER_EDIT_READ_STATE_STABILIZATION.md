# Step 5F.6P.2B - Count/RPC, Context, Folder Edit, and Read-State Stabilization

Date: 2026-06-08

## Executive Summary

Status: PASS for the confirmed 5F.6P.2A blockers.

The count/RPC regression is repaired, the Classify New queue now uses the actual unclassified anti-join, buyer context has a participant-derived fallback, read-state sync has an automatic READ queue path, smart folder editing is stabilized, and operator maintenance buttons are moved behind Advanced.

Current final production truth after all validation:

```text
Canonical conversations: 513
Direct unclassified RPC: 0
Mailbox smart_folder_counts.unclassified: 0
Mailbox Unclassified filter matching_total: 0
Dedicated unclassified queue rows: 0
Classified rows returned by unclassified queue/filter: 0
```

Beta readiness moves from 72% to 88%. Remaining risk is not the repaired blockers; it is operational hardening: schedule the pending READ queue processor, deploy the changed static frontend, and continue full-archive maintenance under admin control.

## Issue 1 Repair - Counts and Unclassified Queue

Root cause confirmed:

The latest `get_ebay_canonical_mailbox_v2` replacement lost the `unclassified` system-filter branch and lost `smart_folder_counts.unclassified`. `Classify New` then trusted a broken mailbox queue and examined the latest 100 conversations instead of the actual unclassified queue.

Bad pre-fix evidence:

```text
Run: 55776131-f3bc-4468-883e-e4ae1ef189c2
Queue: get_ebay_canonical_mailbox_v2:unclassified
Target/processed: 100
Attempted/classified: 34
Skipped already classified: 66
Remaining/unclassified_before: 511
Direct DB truth at audit time: 17 unclassified
```

Repairs:

- Added migration `20260608223000_email_triage_count_context_folder_read_stabilization.sql`.
- Restored mailbox RPC `unclassified` filter branch: `classification_id is null`.
- Restored `smart_folder_counts.unclassified`.
- Preserved participant identity and provider read-state behavior by patching the existing live RPC definition rather than replacing it wholesale.
- Added `count_ebay_unclassified_conversations()`.
- Added `get_ebay_unclassified_conversation_queue(_limit)`.
- Updated `ebay-conversation-classify` to prefer the dedicated unclassified queue.
- Added a guard that rejects mailbox unclassified candidates if any already have a current classification.
- Updated the Playwright regression to compare UI count, mailbox count, unclassified filter count, dedicated queue count, and direct count.

Validation:

```text
2026-06-08T22:51Z:
directCount: 18
smartFolderCount: 18
rpcMatchingTotal: 18
uiUnclassified: 18
queuedRows: 18

Classify New run aea6ac33-ceb4-4f0b-8e40-0a2039ddbc6b:
candidates_examined: 18
processed/attempted/classified: 18
skipped: 0
queue_source: get_ebay_unclassified_conversation_queue
remaining_unclassified: 0
```

After a later archive-only backfill inserted one new unclassified conversation, the system again reconciled correctly:

```text
2026-06-08T23:14Z:
directCount: 1
smartFolderCount: 1
rpcMatchingTotal: 1
uiUnclassified: 1
queuedRows: 1

Classify New run 82bf93e9-a874-4d3d-ab91-7d9686872c09:
candidates_examined: 1
processed/attempted/classified: 1
skipped: 0
queue_source: get_ebay_unclassified_conversation_queue
remaining_unclassified: 0
```

Final direct probe at `2026-06-08T23:15:39Z`:

```text
direct_unclassified_rpc_count: 0
all_mailbox.smart_unclassified: 0
unclassified_mailbox.matching_total: 0
dedicated_queue.rows: 0
```

Decision:

The correct number is now the anti-join count of `ebay_conversations` with no current `ebay_conversation_classifications.is_current = true`. Folder, dashboard, banner, RPC, and backend now reconcile against that source.

## Issue 2 Repair - Buyer/Order Context

Architecture:

```text
Source:
eBay conversation/message detail plus locally stored orders, order lines, buyer history, returns, listings, and conversation links.

Pipeline:
Sync/refresh stores conversations and messages.
Context function builds deterministic link candidates from reference ids and now also from message participants.
Link records are stored in ebay_conversation_links.
Buyer/order context is assembled from links, order tables, buyer history, and listing/value metadata.

Storage:
ebay_conversations
ebay_conversation_messages
ebay_conversation_links
ebay_orders and related order line/history tables

Rendering:
email-triage.api.js fetches context with link_and_context.
email-triage.js renders Buyer Summary, Order Context, and Context Status.
```

Repairs:

- Added participant-derived buyer candidates from message sender/recipient when deterministic `other_party_username` or `reference_id` is absent.
- Treats high-confidence participant buyer matches as confirmed buyer context while keeping exact order context separate.
- Added explicit `context_resolution` states:
  - `buyer_found`
  - `buyer_found_no_exact_order`
  - `order_linked`
  - `no_exact_order_link`
  - `provider_detail_refresh_recommended`
- Frontend now calls context mode `link_and_context`.
- Refresh Timeline reloads context after provider detail refresh.

Validation:

`daman_salim`, newer conversation `626c786e-c5cf-4d67-b987-8445c4efb3a7`:

```text
Target conversation deterministic fields: no other_party_username, no reference_id
Context link_result: 1 candidate, 1 link created
Buyer: daman_salim
Matched from: message_participant
Confidence: confirmed
Buyer context status: buyer_found_no_exact_order
Order context status: no_exact_order_link
Provider detail refresh status: recommended
Active link types: buyer_username
```

Control example `conghung081870`, conversation `f252f51a-95d9-49ed-803e-af633177935c`:

```text
Buyer: conghung081870
Matched from: order
Context status: order_linked
Provider detail refresh: not_needed
Order: 04-14594-34311
Item: 287308239347
Title: #812 - JEWELRY ITEM - AS SEEN ON SCREEN
```

Decision:

The system now distinguishes:

```text
Buyer found
Buyer found but no exact order
Order linked
Provider refresh recommended/pending
```

Missing exact order context is no longer rendered as "No buyer context" when buyer identity is present through participants.

## Issue 3 Repair - Read-State Synchronization

Root cause:

Local OG read state and eBay provider read state could drift. The prior production path required an operator to remember `Sync Read to eBay`.

Implemented design:

```text
Read in OG
-> local read RPC sets pending_provider_update when provider is still unread
-> frontend immediately calls process_pending_read
-> ebay-message-read-sync processes queued READ rows
-> provider read state, local read state, pending flag, sync status, and activity ledger reconcile
```

Rules:

- Automatically sync READ.
- Do not automatically sync UNREAD.
- UNREAD remains an explicit admin/operator action.
- A queue processor mode exists for background reconciliation: `process_pending_read`.

Repairs:

- Extended `ebay-message-read-sync` with `process_pending_read`.
- Processes only `pending_provider_update = true`, `local_read_state = read`, provider not read.
- Persists per-row success/failure.
- Records `read_state_synced` and `read_state_sync_failed` activity events.
- Frontend local mark-read now calls the pending READ queue processor automatically.
- Manual read/unread provider actions moved into a detail `Read Sync` advanced menu.

Validation:

Targeted queue validation:

```text
Dry run: queued 3, readOnly true, no mutation
Actual run: beforePending 10, processed 1, succeeded 1, failed 0, afterPending 9
Row: 64b7309a-aff3-4dcf-8279-d1292d66ed49
provider_read_state: read
local_read_state: read
pending_provider_update: false
read_sync_status: synced
last_read_sync_at: 2026-06-08T22:49:26.88Z
Activity event: 7a38da84-c17c-4fc5-9634-23e3ca99dde0, read_state_synced, succeeded
Safety: sendsEnabled false, messagesSent 0
```

Final sampled state after later sync/backfill validation:

```text
sampled conversations: 513
pending_provider_update: 8
failed read sync: 0
```

Decision:

Manual sync is no longer required for the normal "operator opens/marks read in OG" path. Production should still schedule `process_pending_read` periodically so backlog rows are drained even if a browser session closes mid-flow.

## Issue 4 Repair - Folder Logic and Editing

Repairs:

- Split filter UI into:
  - State
  - System / Deterministic
  - Source
  - AI Labels
- Added first-class state filters for `Unread`, `Unclassified`, `Needs Reply Today`, and `Review Queue`.
- Added deterministic/system filters for `Members`, `eBay Notifications`, `Returns`, `Shipping Issues`, `Has Order`, `Has Return`, `Has Media`, and `Needs Review`.
- Built-in folder buttons now show explicit rules instead of hidden behavior.
- `Returns` local fallback now aligns with RPC behavior: `Has Return OR AI Topic: Return`.
- Custom saved folders retain AND logic for selected chips.
- Added a smart-folder edit draft state so selecting a folder in edit mode lights up attached chips without immediately replacing or losing the saved folder.
- Added stable Save/Cancel/Done behavior for folder edit mode.
- Reactivated/repaired saved system views for `needs_reply_today`, `review_queue`, and `has_return`.

Validation:

Playwright:

```text
Smart folder behavior matches canonical RPC:
folderKey: returns
folderLabel: Returns
matching_total: 114
loaded_count: 100
```

Local UI smoke:

```text
Top actions: Refresh, Classify new, Sync recent mailbox, Advanced
Advanced actions: Reclassify recent 20, Backfill archive, Backfill + classify new, Backfill + reclassify all
Filter headings visible after opening panel:
State
System / Deterministic
Source
AI Labels
Topics
Buyer flags
Risk flags
Priority
Response
```

Count explanation:

`Returns` folder count and an AI-only `Return` classification filter are not guaranteed to match. `Returns` is now explicitly an OR built-in folder (`Has Return OR AI Topic: Return`), while an AI topic filter only measures AI topic membership. This is no longer hidden behavior; it is surfaced in folder rule metadata.

Decision:

Folder logic is now understandable to an operator. Custom folders use AND logic; built-ins disclose their state/OR/system logic.

## Issue 5 Repair - Button Cleanup

Repairs:

Visible operator buttons:

```text
Refresh
Classify new
Sync recent mailbox
Advanced
```

Advanced maintenance actions:

```text
Reclassify recent 20
Backfill archive
Backfill + classify new
Backfill + reclassify all
```

Detail-level provider read/unread actions moved behind a `Read Sync` advanced menu. The normal read path now queues/syncs READ automatically.

Validation:

The UI smoke confirmed only the operator actions are visible at top level. The Playwright regression harness was updated to open Advanced before maintenance actions, then validated:

```text
Reclassify recent 20: passed, 20/20 succeeded
Backfill archive: passed
Backfill + classify new: passed
```

## Issue 6 Findings - Additional Beta Blockers

Additional issues found and handled:

- Test harness initially failed after the button cleanup because it still clicked hidden maintenance buttons. Fixed by opening Advanced before admin actions.
- Frontend asset cache-buster was stale (`5f6s4e-20260607`). Updated to `5f6p2b-20260608`.
- Archive-only backfill can create unclassified conversations by design. Counts remained correct, and a follow-up Classify New processed exactly the one new unclassified row.

Remaining non-blocking hardening:

- Add a production schedule for `ebay-message-read-sync` with `mode: process_pending_read`.
- Full-archive `Backfill + reclassify all` was intentionally not run. It remains an admin-only maintenance operation requiring explicit confirmation.
- `deno check` could not be run locally because `deno` is not installed.
- `supabase db lint` could not run against local DB because `127.0.0.1:54322` was not running. Remote migration dry-run and push succeeded.

## Regression Results

Commands and results:

```text
npm run test:email-triage
PASS - default live Playwright regression
Report: tests/email-triage/reports/email-triage-regression-2026-06-08T22-50-36-672Z.md

EMAIL_TRIAGE_RUN_CLASSIFY_UNCLASSIFIED=true npm run test:email-triage
PASS - Classify New 18-row queue
Report: tests/email-triage/reports/email-triage-regression-2026-06-08T22-53-26-035Z.md

EMAIL_TRIAGE_RUN_SYNC_RECENT=true EMAIL_TRIAGE_RUN_REFRESH_TIMELINE=true EMAIL_TRIAGE_RUN_RECLASSIFY_RECENT=true npm run test:email-triage
PASS - Sync Recent, Refresh Timeline, Reclassify Recent 20
Report: tests/email-triage/reports/email-triage-regression-2026-06-08T23-09-27-306Z.md

EMAIL_TRIAGE_RUN_BACKFILL_ARCHIVE=true EMAIL_TRIAGE_RUN_BACKFILL_CLASSIFY_NEW=true npm run test:email-triage
PASS - Backfill Archive, Backfill + Classify New
Report: tests/email-triage/reports/email-triage-regression-2026-06-08T23-13-11-708Z.md

EMAIL_TRIAGE_RUN_CLASSIFY_UNCLASSIFIED=true npm run test:email-triage
PASS - final one-row post-backfill Classify New
Report: tests/email-triage/reports/email-triage-regression-2026-06-08T23-15-08-588Z.md

npm run test:ebay-notification
PASS - 8/8 notification unit tests

npm run test:ebay-notification:live
PASS - challenge 200, unsigned duplicate rejected 412, ledger row id cd5db8d7-a0d9-43be-970d-eaf63f30b10e

node --check email-triage.js
PASS

node --check email-triage.api.js
PASS

node --check tests/email-triage/email-triage-regression.spec.mjs
PASS

git diff --check
PASS
```

Workflow matrix:

```text
Live sync: Passed
Webhook notifications: Passed
NEW_MESSAGE ledger processing: Passed
Sync Recent: Passed
Refresh Timeline: Passed
Provider read-state sync: Passed by targeted queue validation
Classification: Passed
Classify New: Passed
Reclassify Recent 20: Passed
Dashboard: Passed
Mailbox RPC: Passed
Backfill Archive: Passed
Backfill + Classify New: Passed
Controlled send safety: Passed, blocked send attempts 0 and safety messagesSent 0
Backfill + Reclassify All: Skipped by design, expensive full-archive admin operation
```

## Deployment Requirements

Migration required: YES. Applied.

```sh
node_modules/supabase/bin/supabase db push --dry-run
node_modules/supabase/bin/supabase db push --yes
```

Edge Function deploy required: YES. Applied.

```sh
node_modules/supabase/bin/supabase functions deploy ebay-conversation-classify --use-api
node_modules/supabase/bin/supabase functions deploy ebay-conversation-context --use-api
node_modules/supabase/bin/supabase functions deploy ebay-message-read-sync --use-api
node_modules/supabase/bin/supabase functions deploy ebay-message-sync --use-api
node_modules/supabase/bin/supabase functions deploy ebay-conversation-draft --use-api
```

Frontend deploy required: YES. Pending in this workspace.

Changed static files:

```text
email-triage.html
email-triage.css
email-triage.js
email-triage.api.js
email-triage.state.js
```

No frontend deploy script exists in `package.json`; deploy these files through the current static hosting pipeline. The HTML cache-buster is already updated to `5f6p2b-20260608`.

Recommended scheduled read queue command:

```sh
curl -X POST "$SUPABASE_URL/functions/v1/ebay-message-read-sync" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"mode":"process_pending_read","limit":10}'
```

## Updated Beta Readiness

Updated beta readiness: 88%.

Reasoning:

- Count/RPC truth restored and regression-covered.
- Classify New no longer examines arbitrary recent rows.
- Buyer context fallback resolves the confirmed `daman_salim` case.
- Read sync no longer depends on a normal operator remembering a manual button.
- Smart folders are more explainable and edit mode is stable.
- Main workflows passed live regression.

Remaining points are withheld for scheduled read-queue automation, frontend production deployment, and longer full-archive maintenance validation.

## Final Decision

Can we safely move to `5F.6M - Controlled Return Messaging`?

Yes, after deploying the changed frontend static files. No additional stabilization step is required for the 5F.6P.2A blockers.

Do not begin operator-facing controlled return messaging from stale cached frontend assets. Once the frontend deploy is complete, proceed to 5F.6M with the scheduled READ queue processor as a production hardening follow-up.
