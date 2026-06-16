# Step 5F.6P.2A Consistency, Context, Folder Logic, and Read-State Audit

Audit date: 2026-06-08

Scope: consistency audit and repair plan only. No production code, database migrations, Edge Functions, eBay state, or read-state provider mutations were changed by this step. The only intended repository change is this audit document.

Repository state audited:

```text
HEAD: 20298fb
Branch: Rafael_Email_V6
Working tree before document creation: unrelated untracked Iphone_app/ and node_modules/supabase/bin/supabase
```

Validation sources used:

```text
Repo code
Supabase table reads with service-role credentials from .env.email-triage
Latest durable classification run row
Latest saved smart-folder definitions
Direct conversation/classification/order/link table counts
Read-state table state
Local Playwright/browser attempt against email-triage UI
RPC and Edge Function source code
```

Live UI limitation:

```text
The local browser opened http://localhost:4173/email-triage.html but redirected to
/index.html?next=email-triage.html because there was no active admin session.

The RPC was also not directly callable through service-role REST for this audit because
get_ebay_canonical_mailbox_v2 gates through public.can_manage_inventory(), returning
not_authorized.
```

That limitation did not block the core diagnosis: the latest migration source, the Edge Function source, direct table state, and the durable run row agree on the failure mode.

## Executive Summary

Status:

```text
FAIL
```

The system is not consistent enough to proceed directly to `5F.6M - Controlled Return Messaging`.

The primary blocker is a regression in the latest canonical mailbox RPC. The latest `get_ebay_canonical_mailbox_v2` migration removed the `unclassified` system-filter branch and omitted the `unclassified` smart-folder count. As a result, `Classify Unclassified` asked for the unclassified queue, but the RPC returned the latest all-conversation page instead.

That explains the user-observed mismatch:

```text
Candidates examined: 100
Actually classified: 34
Skipped already classified: 66
Remaining unclassified: 511
Folder Unclassified: 0
Dashboard Remaining unclassified: 477
```

Those numbers are not random. They come from different sources:

```text
Banner/run remaining: broken RPC matching_total
Dashboard card: total conversations minus current classification rows
Folder count: missing RPC smart count, then page-local UI fallback
Backend durable run: same broken RPC queue/count
Direct table truth at audit time: 17 unclassified conversations
```

Other blockers found:

- Buyer/order context is sometimes truly missing from storage, not merely hidden by rendering. `daman_salim` has one older conversation linked correctly and one newer conversation with no reference id and no active order link despite stored buyer order history.
- Read-state is intentionally split between local OG state and provider eBay state, but provider sync is manual today. At audit time, 10 conversations were locally read while still pending provider update.
- Smart-folder logic mixes state folders, deterministic/system folders, and AI-label filters without making the semantics visible to the operator. Custom folders use AND logic; several system folders use OR or deterministic-link logic.
- Smart-folder editing is not stable enough for beta trust. Editing currently mutates global filters rather than a folder edit draft, so tags can appear to disappear, folder chips can clear, and Done can look like it saved when it did not.
- Several saved system views are dirty or misleading, including a `Reply today` payload that applies `system_filter: all` and system defaults that are soft-deleted but still marked as defaults.

Beta readiness:

```text
72%
```

This is lower than a feature-complete estimate because the remaining failures directly affect operator trust in counts, folders, context, and read-state.

Final decision:

```text
Do not move to 5F.6M yet.
Complete one more stabilization step first.
```

Recommended next step:

```text
5F.6P.2B - Count/RPC, Context, Folder Edit, and Read-State Stabilization
```

## Issue 1 Findings - Classification Count Consistency

### Finding

The user's interpretation is substantially correct: `Classify Unclassified` should only examine conversations that are currently unclassified. In the latest observed run, it did not.

The durable run row proves the intended queue and the bad outcome:

```text
run_id: 55776131-f3bc-4468-883e-e4ae1ef189c2
run_mode: classify_unclassified_conversations
status: succeeded
started_at: 2026-06-08T20:14:06.811099+00:00
completed_at: 2026-06-08T20:16:00.857+00:00
requested_limit: 100
target_count: 100
processed_count: 100
attempted_count: 34
classified_count: 34
skipped_count: 66
unclassified_before: 511
remaining_unclassified: 511
queue_source: get_ebay_canonical_mailbox_v2:unclassified
canonical_queue: unclassified
```

The function thought it was using the canonical unclassified queue. The queue was wrong because the latest RPC no longer implements the `unclassified` system filter.

### Evidence From Code

`email-triage.js` calls classification with a limit derived from the loaded conversation count, capped at 100:

```text
limit = Math.min(Math.max(loadedCount || 100, 1), 100)
```

`supabase/functions/ebay-conversation-classify/index.ts` then calls:

```text
get_ebay_canonical_mailbox_v2
_system_filter: unclassified
_limit: 100
```

The latest migration, `supabase/migrations/20260608133000_ebay_canonical_mailbox_participant_identity.sql`, has branches for many system filters but does not include:

```text
when 'unclassified' then b.classification_id is null
```

An earlier migration, `supabase/migrations/20260606170000_ebay_unclassified_queue_visibility.sql`, did include the unclassified branch and count. The latest migration regressed it while adding participant identity logic.

### Answers To Required Questions

1. What exactly is being examined?

The latest run examined 100 rows returned by `get_ebay_canonical_mailbox_v2` with `_system_filter = 'unclassified'`. Because the latest RPC does not recognize that filter, those rows were effectively the latest all-conversation page.

2. What queue is being used?

Intended queue:

```text
get_ebay_canonical_mailbox_v2:unclassified
```

Actual queue:

```text
latest all-conversation page, limited to 100
```

3. Why 100?

The frontend/Edge Function flow caps the batch at 100. If the UI has 100 loaded conversations, `Classify Unclassified` requests 100 candidates.

4. Why 34 classified?

Among the accidental 100 all-conversation candidates, 34 were missing or stale enough to classify at the time of the run.

5. Why 66 skipped?

The other 66 candidates already had fresh current classifications, so the Edge Function skipped them as `current_classification_fresh`.

6. Why did the folder say 0?

The latest RPC omitted `smart_folder_counts.unclassified`. The folder UI therefore did not receive an archive-wide unclassified count from the RPC. In the observed state, the loaded page had no visible unclassified rows, so the folder count could present as 0 even while the archive still had unclassified conversations.

7. Why did the dashboard say 477?

The dashboard count is derived from table counts:

```text
ebay_conversations count - ebay_conversation_classifications where is_current = true
```

The observed `477` is explainable as a direct table delta at that moment, separate from the broken RPC count and separate from the loaded-page folder fallback.

8. Why did the banner say 511?

The banner used the durable classification run payload. The run's `remaining_unclassified` and `unclassified_before` were populated by the broken RPC `matching_total`, so the run recorded total conversations as "unclassified".

9. Are these values derived from different sources?

Yes.

```text
Banner: latest classification run row
Run row: countUnclassifiedConversations(), which trusted the broken RPC
Dashboard: direct table total minus current classification rows
Folder: RPC smart_folder_counts when present, otherwise UI/local fallback behavior
Backend queue: RPC page rows from get_ebay_canonical_mailbox_v2
```

10. Which number is actually correct?

At audit time, direct table truth was:

```text
total_conversations: 511
distinct_current_classified_conversations: 494
direct_unclassified_by_distinct: 17
duplicate_current_classification_rows: 0
```

So the correct current unclassified count was:

```text
17
```

After the RPC repair, the folder count, dashboard count, banner count, RPC count, and backend queue should all reconcile to the same direct-table value.

### Issue 1 Verdict

```text
Confirmed blocker.
```

The unclassified filter/count regression must be fixed before any more operator-facing workflow work.

## Issue 2 Findings - Buyer / Order Context Architecture and Failures

### Architecture

Source:

```text
eBay conversation sync
eBay conversation messages
eBay orders and order lines
eBay return cases
Inventory/listing records
Message reference ids and participant usernames
```

Pipeline:

```text
sync/backfill fetches conversations and messages
-> conversation/message rows are upserted
-> context extraction/linking code derives order/listing/return/buyer references
-> ebay_conversation_links stores deterministic links
-> buildEbayConversationContext hydrates linked context for display/classification/drafting
```

Storage:

```text
ebay_conversations
ebay_conversation_messages
ebay_conversation_links
ebay_orders
ebay_order_lines
ebay_return_cases
inventory/listing-related tables
ebay_conversation_classifications for AI metadata
```

Rendering:

```text
renderEbayConversationContextPanel(...)
```

The UI renders stored/hydrated context. It does not independently fetch missing eBay order context at render time.

### daman_salim

Direct table state shows two conversations for `daman_salim`.

Older conversation:

```text
conversation_id: 29b9735f-90a2-4ed4-b4c1-93172a50ef00
ebay_conversation_id: 125394027800
reference_id: 287349763451
messages: 6
active order link: yes
order: 05-14685-84335
```

Newer conversation:

```text
conversation_id: 626c786e-c5cf-4d67-b987-8445c4efb3a7
ebay_conversation_id: 125826980700
latest_message_at: 2026-06-08T17:55:47+00:00
message sender: daman_salim
reference_id: null
reference_type: null
active order link: no
```

Stored order history for `daman_salim` exists, including recent orders. Therefore this is not a simple "buyer has no orders in OG" case.

Conclusion:

```text
The missing context is real in storage for the newer daman_salim conversation.
It is not merely a rendering bug.
```

Likely failure mode:

```text
The new conversation did not persist an item/listing/order reference id, and deterministic
context linking does not currently create buyer/order context from message participant
username alone.
```

If eBay's UI clearly shows order/listing context for that newer conversation, OG either did not fetch the richer conversation detail payload or did not persist/link the reference fields from that payload.

### conghung081870

Direct table state shows linked context working correctly.

Member conversation:

```text
conversation_id: f252f51a-95d9-49ed-803e-af633177935c
reference_id: 287308239347
active order link: yes
order: 04-14594-34311
item: #812 - JEWELRY ITEM - AS SEEN ON SCREEN
```

Platform notification conversation:

```text
active order link: yes
active return/listing context: yes
```

Conclusion:

```text
The context architecture can work.
It fails when the conversation lacks deterministic reference fields and only participant identity is available.
```

### Required Answer

Should missing context be fetched directly from eBay?

Yes, for a bounded fallback:

```text
If a selected or newly synced conversation has ebay_conversation_id but no reference_id
and no active order/listing/return link, enqueue a targeted eBay conversation detail refresh.
```

That should be paired with a deterministic buyer fallback:

```text
If participant username is known and no specific order can be linked, hydrate buyer history
and show "buyer context only" rather than "No buyer context".
```

The UI should distinguish:

```text
No buyer found
Buyer found, no specific order linked
Specific order linked
Provider detail refresh pending
Provider detail unavailable
```

### Issue 2 Verdict

```text
Confirmed blocker for operator trust.
```

The architecture works for conversations with reference ids, but it needs participant-derived buyer context and targeted provider detail repair for reference-less conversations.

## Issue 3 Findings - Read / Unread Synchronization Design Review

### Current Behavior

The current behavior is intentional.

Opening an unread conversation marks it read locally in OG. The database tracks provider and local state separately:

```text
provider_read_state
local_read_state
provider_sync_status
provider_update_pending
provider_state_last_seen_at
local_state_changed_at
```

The local mark-read RPC sets local read state and marks provider sync pending when eBay is still unread. Provider mutation is handled separately by the `ebay-message-read-sync` Edge Function.

### Live Read-State Evidence

At audit time:

```text
unread_count_predicate: 19
provider_unread: 29
local_unread: 19
pending_provider_update: 10
provider_update_failed: 0
provider_unknown: 7
```

This proves the concern:

```text
OG can show a conversation as locally read while eBay still has unread provider state.
```

### Is Manual Synchronization Necessary Today?

Yes. With the current implementation, the operator must use provider sync controls to push local read changes to eBay.

### Can Read-State Become Automatic?

Yes. It should.

The best production architecture is hybrid:

```text
1. Immediate optimistic local update when the operator opens or explicitly marks read.
2. Durable provider-sync queue row is created automatically.
3. Background worker/Edge Function pushes read state to eBay with retry/backoff.
4. Provider reconciliation updates OG from eBay during webhook/recent-sync/backfill events.
5. UI shows pending/aligned/failed status and exposes manual retry only in advanced controls.
```

### Can We Safely Synchronize Both Directions?

Yes, with direction-specific rules:

Provider to OG:

```text
Sync/webhook events can update provider_read_state and, when there is no newer local intent,
can reconcile local state.
```

OG to provider:

```text
Operator read/open actions can mark read automatically through the queue.
```

Recommended safety rule:

```text
Automatically push read=true from OG to eBay.
Do not automatically push unread=true to eBay unless the operator explicitly marks unread.
```

This avoids surprising the operator by resurrecting unread state on eBay.

### Issue 3 Verdict

```text
Confirmed design gap.
```

Manual provider sync is acceptable during stabilization, but not acceptable as the default production workflow.

## Issue 4 Findings - Operational Button Cleanup

Current visible buttons:

```text
Refresh
Classify Unclassified
Reclassify Recent 20
Backfill Archive
Backfill + Classify New
Backfill + Reclassify All
Sync Recent Mailbox
```

The user is correct that too many stabilization/admin actions are exposed.

### Operator Buttons To Keep Visible

Recommended visible production controls:

```text
Refresh
Sync Recent Mailbox
Classify New
Retry Read Sync, only when pending/failed read sync exists
Refresh Context, only in conversation detail when context is missing/stale
```

`Classify Unclassified` should be renamed after the RPC repair:

```text
Classify New
```

The action should report:

```text
unclassified before
candidates examined
classified
skipped
remaining unclassified
```

Only if all values come from the repaired canonical unclassified queue.

### Admin / Advanced / Maintenance Buttons

Move behind an admin or maintenance panel:

```text
Reclassify Recent 20
Backfill Archive
Backfill + Classify New
Backfill + Reclassify All
Sync Read to eBay
Sync Unread to eBay
Force provider reconciliation
Raw diagnostics
```

The operator should not have to choose between stabilization workflows during ordinary inbox triage.

### Issue 4 Verdict

```text
Confirmed UX cleanup needed.
```

The production UI should expose common workflows and hide maintenance actions.

## Issue 5 Findings - Smart Folder Logic Audit

### Intended Model

The intended model is sound:

```text
Conversation-level labels:
  deterministic labels from system/provider/database state
  AI labels from classification metadata

Folders:
  saved views that may combine state, deterministic labels, and AI labels
```

The current implementation partially supports this, but the UX does not make the difference clear enough.

### Custom Folder Logic

Custom classification filters use AND logic.

Evidence:

```text
Frontend: ebayClassificationHasAll(...)
RPC: topic_tags @> selected_topics, buyer_flags @> selected_buyer_flags, etc.
```

This means a custom folder containing:

```text
VIP Buyer + Return
```

should match conversations that have both labels, not either label.

### Built-In Folder Logic

Built-in system folders do not all behave like tag folders.

Examples:

Returns:

```text
RPC count logic: has_return_link OR topic_tags contains return
Classification filter "Return": topic_tags contains return only
```

Shipping:

```text
topic_tags overlaps any of:
shipping_issue
missing_item
order_status
delivery_timing
```

Refund risk:

```text
risk_flags overlaps any of:
refund_risk
chargeback_risk
unsupported_claim_risk
```

Review queue:

```text
unclassified OR context-review/stale/low-confidence conditions
```

Therefore, some built-in folders are OR rule sets and some are deterministic-link/state folders. They are not equivalent to selecting one visible AI tag.

### Folder Count Discrepancies

Returns discrepancy:

```text
Returns folder: 112
Classification filter Return: 98
```

Live table evidence:

```text
return_tag: 98
returns_system_link_or_tag: 112
return_link: 66
```

Explanation:

```text
The Returns folder counts conversations with a return link OR an AI Return topic.
The Classification filter counts only conversations with the AI Return topic.
```

This discrepancy is explainable, but the UI does not explain it. Worse, the frontend local fallback predicate for the Returns saved view checks only the AI return topic, while the RPC uses return link OR return topic. That means Returns can disagree between RPC mode and fallback/local mode.

Shipping discrepancy:

```text
Shipping folder: 132
Description: Shipping Issue, Missing Item, Order Status, Delivery Timing
```

Explanation:

```text
This is OR logic across the listed topics, not AND logic.
```

The UI should state that system folder definitions are rule sets, not selected tag lists.

### Legacy Folder Behavior

The user observed:

```text
Members lights up correctly.
eBay Notifications lights up correctly.
Returns does not light up Return tag.
```

This is consistent with the code:

```text
Members and eBay Notifications are source/state-like system filters.
Returns is a system folder keyed by deterministic return-link OR AI return-topic logic.
```

The Returns folder should show a deterministic/system chip such as:

```text
Has Return OR AI Topic: Return
```

It should not rely on lighting a single AI tag, because its definition is broader than that tag.

### Folder Editing UX

The user is correct that editing can feel unstable.

Current behavior:

```text
Clicking Edit reveals rename/update/delete controls.
Selecting or removing filter tags mutates the global filter controls.
Changing global filter controls clears selectedEbaySavedViewId unless preserveSavedView is set.
Done exits edit mode but does not necessarily save current filter changes.
The update icon saves the current search/filter payload after confirmation.
```

This explains the reported behavior:

```text
Removing one tag can appear to remove multiple tags.
The folder chip can disappear.
Save/Done can appear to restore old state.
```

Live saved view evidence also supports the concern. The active custom folder named:

```text
vip + return tags
```

currently stores buyer flags only:

```text
buyerFlags:
  return_prone_buyer
  high_return_risk_buyer
  high_retained_value_buyer
topics:
  []
```

That does not match the name or the user's expectation that it contains VIP + Return tags.

### Deterministic vs AI Filter Separation

Current AI filter groups:

```text
Topics
Buyer Flags
Risk Flags
Priority
Response
```

Current system/source controls:

```text
Source
Unread/read state badges
Context badges such as Has Order, Has Return, Has Media, Listing
Status/review indicators
```

Recommended production filter model:

```text
State
  Unread
  Unclassified
  Needs Review
  Read sync pending
  Provider unread
  Local unread
  Has draft
  Awaiting reply

System / Deterministic
  Source: Member, eBay Notification
  Has Order
  Has Return
  Has Listing
  Has Media
  Platform Notification
  Order Status

AI
  Topics
  Buyer Flags
  Risk Flags
  Priority
  Response Status
```

State-based folders such as:

```text
Unread
Unclassified
```

should become first-class state filters, not pseudo-tags.

### Issue 5 Verdict

```text
Confirmed blocker for beta polish.
```

Folder logic is partly correct underneath, but the UI conflates state, deterministic rules, and AI labels. Editing needs a real draft/edit model.

## Issue 6 Findings - Additional Beta Blockers

### 1. Latest RPC Regression

The latest mailbox RPC regressed the unclassified filter and count while adding participant identity. This is the highest-priority blocker.

### 2. Saved System View Drift

Live saved view state includes system defaults with problematic payload/state:

```text
Reply today: system_key = needs_reply_today, but filter_payload.system_filter = all
Review queue: is_system_default = true, but deleted_at is set
Has return: is_system_default = true, but deleted_at is set
```

The UI filters out deleted saved views, so system defaults should not be soft-deleted unless intentionally removed from production.

### 3. RPC Authorization Blocks Service-Role Validation

`get_ebay_canonical_mailbox_v2` currently rejects service-role REST calls through `can_manage_inventory()`. That may be acceptable for operator access, but it makes automated non-browser validation harder. A safe validation RPC or service-role allowance should be considered.

### 4. Read-Only Wording Is Misleading

The UI can perform eBay read-state mutations through sync controls, even while the system may describe the mailbox as read-only/no-send. The copy should distinguish:

```text
No automatic replies/sends
Read-state sync may update eBay
```

### 5. Provider Read State Has Unknowns

At audit time:

```text
provider_unknown: 7
```

Unknown provider state is tolerable during migration, but should be surfaced and reconciled before beta.

### 6. Browser UI Validation Was Blocked

Local Playwright/browser validation could not reach the authenticated mailbox UI in this audit. A repeatable authenticated UI smoke-test path is needed for future release gates.

## Recommended Fix Plan

### Priority 1 - Restore Count and Queue Truth

1. Create a migration that restores `unclassified` handling in the latest `get_ebay_canonical_mailbox_v2` implementation:

```text
when 'unclassified' then b.classification_id is null
```

Also restore:

```text
smart_folder_counts.unclassified
```

Keep the participant identity additions from the latest migration.

2. Add a defensive server-side guard in `ebay-conversation-classify`:

```text
If requesting the unclassified queue, verify returned candidates are actually unclassified.
If the RPC returns classified rows or omits an unclassified count, fall back to a direct anti-join query.
```

3. Prefer adding dedicated canonical helpers:

```text
count_ebay_unclassified_conversations()
get_ebay_unclassified_conversation_queue(limit)
```

These should not rely on a broad mailbox saved-view RPC.

4. Repair or annotate the latest bad classification run:

```text
run_id: 55776131-f3bc-4468-883e-e4ae1ef189c2
```

Either update its remaining count to the repaired direct count or add metadata marking the counter invalid due to RPC regression.

5. Fix saved system views:

```text
Reply today payload must use needs_reply_today
Review queue default should not be deleted if it is still intended
Has return default should not be deleted if it is still intended
```

6. Post-deploy validation must prove:

```text
Folder Unclassified = Dashboard Unclassified = RPC matching_total for unclassified = direct DB anti-join count
Classify New candidates examined <= current unclassified count
Classify New cannot examine already classified rows except stale rows explicitly selected by a reclassify mode
```

### Priority 2 - Repair Context and Read-State Production Flow

1. Add participant-derived buyer context fallback:

```text
Use message sender/recipient participant username when other_party_username/reference_id is missing.
Hydrate buyer order history from stored eBay orders.
Show "buyer context only" when no exact order can be linked.
```

2. Add targeted provider detail refresh:

```text
When a conversation has ebay_conversation_id but no reference_id/order/listing/return link,
enqueue an eBay detail refresh and run context linking again.
```

3. Add a durable read-state sync queue:

```text
Local read action -> queue provider read update -> Edge worker syncs eBay -> provider/local state reconciled
```

4. Add reconciliation rules:

```text
Provider events update provider_read_state.
Local actions update local_read_state.
Newest explicit local intent wins until provider sync succeeds/fails.
Manual controls become Retry/Advanced, not the normal path.
```

### Priority 3 - Make Folder Logic Understandable

1. Rebuild smart-folder editing around a draft:

```text
Select folder
-> enter edit draft
-> attached state/system/AI chips light up
-> add/remove chips mutates draft only
-> Save applies draft
-> Cancel/Done exits without accidental restore
```

2. Split filters into:

```text
State
System / Deterministic
AI
```

3. Make built-in folder definitions visible:

```text
Returns = Has Return OR AI Topic: Return
Shipping = any of Shipping Issue, Missing Item, Order Status, Delivery Timing
Review Queue = Unclassified OR Needs Review conditions
```

4. Hide maintenance buttons behind admin/advanced mode.

5. Update button and result copy:

```text
Classify Unclassified -> Classify New
Reclassify Recent 20 -> Advanced
Backfill actions -> Maintenance
```

## Deployment Requirements

Migration required?

```text
Yes.
```

Required for:

```text
get_ebay_canonical_mailbox_v2 unclassified repair
smart_folder_counts.unclassified repair
saved system view payload/deleted_at cleanup
optional dedicated unclassified queue/count RPCs
optional read-state queue tables
```

Edge Function deploy required?

```text
Yes.
```

Required for:

```text
ebay-conversation-classify defensive unclassified queue validation
ebay-conversation-context participant/context fallback
ebay-message-read-sync queue worker behavior, if implemented
```

Frontend deploy required?

```text
Yes.
```

Required for:

```text
folder edit draft UX
state/system/AI filter separation
operator/admin button cleanup
read-state pending/retry UI
context missing/detail-refresh UI
consistent count display
```

## Beta Readiness

Updated estimate:

```text
72%
```

Rationale:

```text
Core primitives exist, but the operator cannot yet fully trust counts, folder definitions,
context completeness, or read-state alignment.
```

Expected after Priority 1:

```text
82% to 85%
```

Expected after Priority 2:

```text
88% to 91%
```

Expected after Priority 3:

```text
92% to 95%
```

## Final Decision

Can we safely move to `5F.6M - Controlled Return Messaging`?

```text
No.
```

Must another stabilization step be completed first?

```text
Yes.
```

Minimum stabilization gate before 5F.6M:

```text
1. Repaired unclassified RPC filter/count deployed.
2. Classify New proven to examine only current unclassified conversations.
3. Folder, dashboard, banner, RPC, and direct DB unclassified counts reconcile.
4. daman_salim-style missing context has buyer fallback or provider detail refresh.
5. Read-state automatic queue design is implemented or explicitly deferred with clear beta warning.
6. Smart-folder edit instability is fixed or the editing feature is disabled for beta.
```

