# Step 5F.6S Comprehensive Regression Audit

Audit date: 2026-06-07

Scope: system-wide regression audit and stabilization plan only. No production code, migrations, Edge Functions, frontend behavior, deployments, eBay state, Outlook state, database objects, or local data were changed. The only repository change made for this step is this audit document.

Repository state audited:

```text
HEAD: c6fc8a6 Step 5F.6A.2C Align "Classify Unclassified" With Canonical Unclassified Queue
Branch: Rafael_Email_V6
Working tree before audit: only unrelated untracked Iphone_app/ and node_modules/supabase/bin/supabase
```

Required source-of-truth documents read completely:

- `docs/email-triage/STEP_5F6A_CANONICAL_SYNC_ARCHITECTURE_AUDIT.md`
- `docs/email-triage/STEP_5F6A1_RECOVERY_DECISION_AUDIT.md`
- `docs/email-triage/STEP_5F6A1B_RPC_REPAIR_AUDIT.md`

Recent implementation work reviewed:

- `ec9a0db` Step 5F.6A.1C RPC replacement and validation gate
- `c50b01f` Step 5F.6A.2 frontend cutover to canonical mailbox RPC
- `146597b` Step 5F.6A.2A smart folder count mapping fix
- `950c372` Step 5F.6A.2B unclassified queue and classification status reconciliation
- `c6fc8a6` Step 5F.6A.2C classify-unclassified canonical queue alignment

Validation performed during this audit:

```text
node --check email-triage.js
node --check email-triage.api.js
node --check email-triage.diagnostics.js
node --check email-triage.state.js
git diff --check HEAD -- email-triage.js email-triage.api.js email-triage.diagnostics.js email-triage.state.js email-triage.html supabase/functions supabase/migrations
```

All local syntax/whitespace checks above passed. No live database queries, Supabase deploys, Edge Function deploys, eBay API mutations, or browser-auth production smoke tests were run in this step.

## Executive Summary

The system is no longer in the original "300 canonical rows but only 100 visible forever" state. The current production-facing architecture now has:

```text
Canonical mailbox RPC v2
-> archive-wide total and matching counts
-> DB-derived smart folder counts
-> server-side search/filter
-> Load more pagination
-> legacy fallback if the RPC fails
-> canonical unclassified queue targeting
```

That is a major recovery from the 5F.6A incident.

However, the platform is not stable enough to resume feature development without a short stabilization pass. The remaining regressions are less catastrophic than the broken mailbox cutover, but they are exactly the kind that can reintroduce operator distrust:

- The HTML cache-buster still references `v=5f6a2b`, while the latest classify-unclassified repair is `5F.6A.2C`; deployed browsers can keep running stale JS unless external cache invalidation is guaranteed.
- Sync Latest and Refresh Timeline use the same Edge Function and canonical tables, but they are different sync modes with different scope, checkpoint semantics, list reload behavior, and operator interpretation.
- `messagesUpdated` in sync results means "existing fetched messages were upserted", not "message content visibly changed"; this can explain updated-message counters with unchanged previews/timelines.
- Read/unread state is still local-only and provider read state is intentionally preserved away during sync.
- Controlled sending is functional, but the sent outbound message is not persisted into `ebay_conversation_messages` immediately; the UI inserts an optimistic message and waits for later sync to canonicalize provider-side delivery.
- Reclassify inbox remains bounded to at most 100 recent conversations despite wording that implies the whole inbox.
- Dashboard totals are mixed: some are exact counts, while topic/risk/draft/send breakdowns are derived from limited recent row pulls.

Overall status:

```text
Beta readiness: Not ready
Estimated completion toward beta: 68%
Primary blocker class: consistency and operator-trust stabilization, not missing core primitives
```

## Working Components

These components appear architecturally sound from static audit:

- Canonical eBay conversation/message schema with uniqueness constraints for conversations and messages.
- Canonical mailbox RPC v2 read model using `public.get_ebay_canonical_mailbox_v2(...)`.
- Frontend mailbox RPC cutover with legacy fallback.
- Archive-wide canonical total, matching total, smart folder counts, and Load More pagination in normal RPC mode.
- Source derivation from `ebay_conversations.conversation_type`, not the nonexistent `ebay_conversations.conversation_source`.
- Unclassified smart folder count exposed by the RPC.
- Classify Unclassified now targets the canonical unclassified queue through RPC v2, with a direct canonical fallback.
- Single-conversation classification path.
- Current classification uniqueness through partial unique index.
- Classification freshness checks based on latest message id/timestamp.
- Shared context builder used by classification and drafting.
- Buyer/order/return context payload construction.
- Draft generation, regeneration, improvement, manual composer, save/edit, approval, unapproval, discard, and draft history.
- Controlled send guardrails: human confirmation, approval requirement for AI drafts, manual-send bypass only for operator-written drafts, stale-draft blocking, validation-status blocking, inbound target requirement, idempotency key, and duplicate-success guard.
- Dashboard event feed and activity detail rendering for sync, classification, backfill, draft, approval, and send attempts.
- Historical backfill checkpointing and chunked continuation.
- Read-only archive integrity validator exists in SQL.

## Partially Working Components

These components work but still have consistency or scale risks:

- **Mailbox fallback mode.** RPC failure no longer blanks the mailbox, but fallback counts/filters are page-derived and not equivalent to canonical RPC semantics.
- **Search and filters.** In RPC mode they are archive-wide. In legacy fallback they are loaded-page only.
- **Load More.** Offset pagination works conceptually, but can shift if sync updates ordering while the user pages.
- **Smart folders.** RPC counts are canonical. Frontend local predicates still differ in fallback mode, especially `returns`, which checks only AI topic locally while RPC counts return links or return topic.
- **Refresh Timeline.** It updates the selected conversation via targeted sync and reloads messages/drafts, but then reloads page 1 of the current mailbox query. The selected row can disappear or stay visually inconsistent if it falls outside the current server page/filter.
- **Sync Latest.** It is useful for recent changes but not a complete change feed. It remains one page per type from the UI, latest-windowed for `FROM_MEMBERS`, and post-fetch filtered for `FROM_EBAY`.
- **Sync result counters.** `messagesUpdated` overstates visible updates because every existing fetched message increments the counter before comparing actual content.
- **Classify Unclassified.** It now targets the correct canonical queue, but the UI limit is still capped at 100 per run.
- **Reclassify Inbox.** It uses recent conversations and a max-100 limit; it is not full-inbox or full-archive reclassification.
- **Backfill + reclassify all.** It reclassifies the current backfill chunk. It can cover the archive only across repeated chunks.
- **Dashboard counts.** Exact for canonical total, unread total, and current classification total. Limited to recent fetched rows for several breakdowns.
- **Send timeline.** Send attempts and draft state are durable. The chat timeline gets an optimistic outbound message, but canonical persisted outbound message visibility depends on later provider sync.
- **Read/unread.** Local mark-read persists locally, but provider state is not reconciled.

## Broken Components

These are confirmed broken or misleading enough to block beta stabilization:

1. **Frontend asset cache version is stale.**
   `email-triage.html` still loads `email-triage.api.js?v=5f6a2b`, `email-triage.diagnostics.js?v=5f6a2b`, and `email-triage.js?v=5f6a2b` even though HEAD includes 5F.6A.2C changes. If static hosting/browser cache honors query strings, users can keep running pre-5F.6A.2C code.

2. **Sync Latest updated-message counters are semantically misleading.**
   Existing messages increment `messagesUpdated` merely because they were fetched/upserted. This can report updated messages while previews and timelines remain unchanged.

3. **Provider read/unread synchronization is not implemented.**
   Existing conversation `unread_count` and existing message read fields are preserved during sync. 5F.6P cannot safely build on this without a provider/local/pending state model.

4. **Reclassify Inbox label does not match behavior.**
   The UI says "Reclassify inbox", result copy says "Reclassify entire inbox", but the implementation targets at most 100 recent conversations.

5. **Post-send canonical timeline persistence is incomplete.**
   A successful send marks the draft/send attempt durable and inserts an optimistic UI message, but it does not immediately insert the outbound provider message into `ebay_conversation_messages`.

6. **No durable started event for sync/backfill is emitted from the current sync handler.**
   Progress/completed/failed events exist, but operators still lack a durable "started/running" lifecycle entry for latest sync and backfill invocations.

## Required Audit Areas

### 1. Mailbox

Status: mostly working in RPC mode, partially working in fallback mode.

Validated architecture:

- `fetchEbayConversations(...)` calls `get_ebay_canonical_mailbox_v2(...)` by default.
- On RPC failure, it logs a warning and falls back to direct table pagination.
- RPC v2 returns `canonical_total`, `matching_total`, `loaded_count`, `page_size`, `offset`, `next_offset`, `has_more`, `smart_folder_counts`, `filter_option_counts`, and page conversations.
- Load More uses `next_offset` and merges pages by conversation id.

Remaining regressions:

- Fallback mode is not canonical. Counts and filters are limited to loaded rows.
- Offset pagination can duplicate/skip rows if latest timestamps change while paging.
- `returns` fallback predicate still differs from RPC semantics.
- The list reload after timeline refresh always requests offset 0; it can lose selected row visibility after a targeted sync.
- Asset cache query strings can leave operators on stale mailbox/classification JS.

Assessment by requested item:

| Item | Status | Notes |
| --- | --- | --- |
| Canonical counts | Working in RPC mode | Exact DB-derived totals. |
| Matching counts | Working in RPC mode | Server-side filters/search. |
| Pagination | Partially working | Offset based; Load More exists. |
| Load more | Working with caveat | Depends on stable ordering. |
| Archive visibility | Mostly working | Full archive reachable by pages in RPC mode. |
| Search | Working in RPC mode | Fallback search is page-local. |
| Smart folders | Mostly working | RPC counts canonical; fallback drift remains. |
| Saved folders | Mostly working | Saved payloads apply server filters in RPC mode. |
| Classification filters | Mostly working | Server-side in RPC mode. |
| Conversation previews | Partially working | Preview consistency depends on sync detail freshness and list reload page. |
| Latest message display | Partially working | Detail sync updates canonical latest fields; send path is optimistic until later sync. |

### 2. Sync

Status: partially working.

Definitive answer:

```text
Sync Latest and Refresh Timeline use the same Edge Function and the same canonical upsert helpers.
They do not use the same sync path.
```

Sync Latest path:

```text
Frontend syncLatestEbayConversations
-> runEbayConversationImport
-> ebay-message-sync
-> runType incremental
-> checkpointScope commerce_message_latest_sync
-> conversationTypes FROM_MEMBERS + FROM_EBAY
-> conversationPageLimit 25
-> messagePageLimit 25
-> maxConversationPages 1
-> latestSyncLookbackDays 14
-> mailbox reload page 1
```

Refresh Timeline path:

```text
Frontend refreshEbayConversationTimeline
-> ebay-message-sync
-> runType manual by default
-> conversationId selected eBay conversation id
-> conversationTypes selected source type when known
-> conversationPageLimit 1
-> messagePageLimit 50
-> maxConversationPages ignored for targeted detail
-> maxDetailPagesPerConversation 20
-> reload selected messages
-> reload selected drafts
-> reload mailbox page 1
```

Authoritative data source for both:

```text
public.ebay_conversations
public.ebay_conversation_messages
public.ebay_conversation_links
public.ebay_message_sync_runs
public.ebay_message_sync_checkpoints, for incremental/backfill only
public.ebay_message_activity_events
```

Why they can disagree:

- Refresh Timeline targets one conversation and fetches detail directly.
- Sync Latest scans only the latest page/window and may not include the selected conversation.
- Sync Latest checkpoint state is updated; Refresh Timeline does not use latest checkpoint semantics.
- Sync Latest list refresh reloads a mailbox page, not the selected timeline.
- `messagesUpdated` counts existing message upserts, not visible changes.

Assessment by requested item:

| Item | Status | Notes |
| --- | --- | --- |
| Sync latest eBay conversations | Partially working | Useful but not a complete latest-change traversal. |
| Conversation updates | Mostly working | Conversation update count based on new messages/latest id changes. |
| Message updates | Misleading | Existing fetched rows count as updated. |
| New conversation ingestion | Working | Insert path persists rows/messages/links. |
| Timeline refresh | Mostly working | Targeted canonical refresh plus direct message reload. |
| Backfill archive | Mostly working | Chunked checkpoints. |
| Backfill + classify new | Mostly working | Chunk scoped; classify-new skips existing classification rows. |

### 3. Classification

Status: mostly working with scope/label issues.

Validated architecture:

- Single conversation classification uses shared context builder and persists one current row.
- Current classification uniqueness is enforced by a partial unique index.
- Reuse logic avoids reclassifying identical input unless forced.
- Unclassified queue now targets canonical RPC v2 `system_filter = 'unclassified'`.
- Direct fallback scans canonical conversations and excludes rows with current classifications.
- Classification result UI reconciles after timeout by reloading mailbox and dashboard.

Remaining regressions:

- Classify Unclassified is still capped at 100 per run by the frontend.
- Reclassify Inbox is at most 100 recent rows and not archive-wide.
- Dashboard unclassified count is exact-ish by subtraction, but direct fallback count can drift if orphan/current violations exist.
- Dashboard topic/risk counts use a 1000-row classification fetch, not exact aggregate SQL.
- Classify-new during backfill is chunk-scoped.

Assessment by requested item:

| Item | Status | Notes |
| --- | --- | --- |
| Single conversation classify | Working | Uses current context and refreshes durable state. |
| Classify unclassified | Mostly working | Correct queue, capped batch. |
| Reclassify inbox | Partially working | Label overstates scope. |
| Backfill + classify | Mostly working | Chunk scoped. |
| Backfill + reclassify all | Partially working | "All" only across repeated chunks. |
| Classification counts | Mostly working | RPC counts canonical; dashboard breakdown limited. |
| Unclassified queue | Working with cap | Canonical queue source fixed. |
| Current classification selection | Working | Current row joined by RPC/list. |
| Classification freshness logic | Mostly working | Latest id/timestamp checks present. |

Internal consistency:

- `classification status` and `current classification` are aligned through `is_current = true`.
- `current draft` carries `classification_id` at generation time, but drafts are allowed to become stale if context/latest message changes.
- Mailbox badges in RPC mode derive from the current classification and server predicates.

### 4. Drafting

Status: working.

Validated architecture:

- Generate AI Reply, regenerate, improve, manual composer, save edit, discard, approve, unapprove, and view flows exist.
- Draft insertion supersedes previous current drafts.
- One current non-discarded draft is enforced by unique index.
- Draft staleness compares draft latest message against current latest stored message.
- AI Instructions are wired into improve/generate paths.
- Manual composer creates operator-written drafts with `source_mode = operator_edit`, `validation_status = valid/warning`, and manual send bypass.

Remaining regressions:

- Save/edit does not refresh draft input/context hashes; a heavily edited draft may still carry old grounding metadata.
- Manual/AI improve paths depend on selected target inbound message availability.
- Draft content and send status are robust; timeline persistence after send is the weaker piece.

Assessment by requested item:

| Item | Status | Notes |
| --- | --- | --- |
| Generate AI Reply | Working | Requires current context and inbound target. |
| Manual Composer | Working | Operator-written, validated, human initiated. |
| AI Instructions | Working | Sent as improvement instructions. |
| Draft Persistence | Working | Current/history model exists. |
| Current Draft Selection | Working | Current first, sent fallback in view payload. |

### 5. Context Builder

Status: mostly working.

Validated architecture:

- Linker extracts order numbers, item numbers, transaction ids, listing ids, labels, return ids, and buyer usernames.
- Links can be confirmed or suggested with confidence scores.
- Context loads linked orders, order lines, returns, return items, inventory listing context, buyer insight summaries, and buyer value breakdown.
- Weak buyer matches skip buyer history and emit warnings.
- Link confidence summary is returned.
- Classification and drafting share the same context builder.

Remaining regressions:

- Link presence is used heavily for folder counts, but link context completeness can still be partial.
- Buyer identity can be ambiguous; warnings exist, but mailbox badges do not distinguish strong versus weak context.
- Context builder loads up to 100 messages; very long conversations can have truncated context.
- Inventory context is explicitly not availability verification.

Assessment by requested item:

| Item | Status | Notes |
| --- | --- | --- |
| Buyer Context | Mostly working | Confirmed/weak distinction present. |
| Order Context | Mostly working | Direct and inferred order links. |
| Return Context | Mostly working | Return cases/items included when linked or inferable. |
| Link Confidence | Working | Strong/medium/weak/none summary. |
| Timeline Rendering | Mostly working | Stored message timeline renders; post-send optimistic gap remains. |

### 6. Sending

Status: partially working, safe but not fully canonicalized.

Validated architecture:

- Controlled sending requires operator confirmation.
- AI drafts require approval and ready-to-send state.
- Manual operator drafts can bypass approval but still require operator action and validation.
- Stale drafts are blocked.
- Target message must be inbound.
- Draft text length is checked against eBay limit.
- Send attempts are durable.
- Duplicate sends are prevented through idempotency and one-success-per-key constraints.
- Dashboard event creation is trigger-backed for send attempts.

Remaining regressions:

- The provider send success does not immediately create an outbound canonical message row.
- UI timeline uses optimistic sent message after success.
- If provider delivery is unknown, the system correctly blocks trust, but operator reconciliation remains manual.
- Return messaging is not implemented in the canonical conversation composer.

Assessment by requested item:

| Item | Status | Notes |
| --- | --- | --- |
| Controlled Sending | Working | Human-only with approval/idempotency. |
| Send Status | Working | Attempts, success/failure/duplicate visible. |
| Timeline Update After Send | Partially working | Optimistic UI only until sync imports provider message. |
| Dashboard Event Creation | Working | Trigger-backed activity events. |

### 7. Dashboard

Status: mostly working.

Validated architecture:

- Dashboard reads exact canonical conversation, unread, and current classification counts.
- It reads recent classifications, drafts, approvals, attempts, activity events, and archive checkpoints.
- Backfill checkpoint rendering distinguishes running/paused/succeeded/failed.
- Activity detail cards expose sync/classification/backfill/send metrics.

Remaining regressions:

- Some breakdowns are limited by `.limit(1000)` or `.limit(100)`.
- Latest sync dashboard uses the most recent sync event, not necessarily the most recent active sync run.
- There is still no durable started/running event for latest sync or backfill in the current sync handler.
- Dashboard can show durable success after browser timeout; this is now partly reconciled in UI for request timeout, but not all fetch failures are reconciled.

Assessment by requested item:

| Item | Status | Notes |
| --- | --- | --- |
| Operation Events | Working | Activity table is central feed. |
| Sync Events | Mostly working | Completed/failed aggregate events. |
| Classification Events | Working | Aggregate run event exists. |
| Send Events | Working | Trigger-backed attempts. |
| Counts | Partially working | Mixed exact and limited-row computations. |
| Refresh Behavior | Mostly working | Manual and post-action refreshes exist. |

### 8. Database Consistency

Status: structurally strong, needs live validation.

Existing protections:

- Unique conversation key: `(seller_account_id, conversation_type, ebay_conversation_id)`.
- Unique message key: `(seller_account_id, conversation_type, ebay_conversation_id, ebay_message_id)`.
- One current classification per conversation.
- One current non-discarded draft per conversation.
- One successful send per idempotency key.
- Provider message unique index for send attempts.
- Foreign keys cascade or null related rows.
- `validate_ebay_message_archive_integrity(uuid)` checks duplicate keys, orphaned records, missing latest message, bad context links, and multiple current classifications.

Gaps:

- The integrity validator is not surfaced in the UI or dashboard.
- Scoped orphan classification check uses the joined conversation seller id, so seller-scoped orphan detection can undercount orphan rows.
- No validator currently checks stale classifications by latest message timestamp.
- No validator checks current draft/classification mismatch or stale current draft counts.
- No validator reconciles checkpoint totals against canonical counts by conversation type.
- No validator checks read-state mismatch between provider-observed state and local display state because provider-observed state is not modeled yet.

Assessment by requested item:

| Item | Status | Notes |
| --- | --- | --- |
| Orphaned Records | Partially covered | SQL validator exists; not operationalized. |
| Stale Classifications | Partially covered | UI/RPC review queue detects some stale rows; no standalone validator. |
| Current-Record Violations | Mostly covered | Unique indexes for classifications/drafts. |
| Count Mismatches | Partially covered | RPC/dashboard compare possible; no automated gate. |
| Sync-State Mismatches | Partially covered | Checkpoints exist; latest/backfill semantics still need reconciliation. |

## Regression Risks

- **Cache/cutover risk:** stale browser assets can silently undo 5F.6A.2C behavior.
- **Fallback drift risk:** RPC fallback prevents blank screens but reintroduces loaded-page semantics.
- **Counter trust risk:** sync "updated messages" can imply visible changes that did not happen.
- **Read-state risk:** local mark-read can permanently mask provider unread state until 5F.6P redesign.
- **Pagination drift risk:** offset pagination can become inconsistent while sync updates ordering.
- **Scope-label risk:** "Reclassify inbox" and "Backfill + reclassify all" overpromise their actual target scope.
- **Post-send evidence risk:** operators may see optimistic sent message before canonical provider import.
- **Dashboard scale risk:** limited-row breakdowns become inaccurate as volume grows.
- **Context confidence risk:** weak/suggested context can still feed labels/counts unless operators inspect detail warnings.
- **Validation gap risk:** there is no single repeatable regression gate that exercises mailbox RPC, classification queue, sync, timeline refresh, dashboard, and send state together.

## Recommended Fix Order

### Priority 1

Stabilize the surfaces that can mislead operators immediately.

1. Bump frontend asset versions or use a deploy hash so browsers cannot run stale 5F.6A.2B JS after 5F.6A.2C.
2. Rename or change sync counters so `messagesUpdated` means actual changed rows, or display it as "existing messages rechecked".
3. Make Sync Latest and Refresh Timeline status copy explicit:
   - Sync Latest: recent/page-limited incremental scan.
   - Refresh Timeline: selected-conversation targeted sync.
4. Rename "Reclassify inbox" to "Reclassify recent 100" or implement a real database-scoped job.
5. Add a post-send canonicalization step:
   - either immediately insert a local outbound message row tied to the send attempt,
   - or label the optimistic message clearly until provider sync imports it.
6. Surface RPC fallback mode loudly because fallback means counts/search/filter semantics are degraded.

### Priority 2

Build a repeatable regression gate before 5F.6P or 5F.6M.

1. Add a read-only validation script/checklist that runs:
   - mailbox RPC no-filter page 1/page 2,
   - smart counts compared to independent SQL,
   - unclassified queue count,
   - classify-unclassified dry run target count if available,
   - latest sync result reconciliation,
   - targeted timeline refresh,
   - dashboard count comparison,
   - archive integrity RPC.
2. Add dashboard visibility for `validate_ebay_message_archive_integrity(...)`.
3. Add stale classification/draft validators.
4. Add exact aggregate dashboard queries for topic/risk/response/draft/send breakdowns instead of limited-row approximations.
5. Emit durable started/running events for latest sync and backfill.

### Priority 3

Prepare the remaining roadmap safely.

1. Implement 5F.6A.3 durable sync/backfill status reconciliation:
   - chunk success versus archive complete,
   - browser timeout versus durable state,
   - latest checkpoint health by type.
2. Implement 5F.6P provider-aware read/unread:
   - provider-observed state,
   - local display state,
   - pending provider mutation state,
   - reconciliation policy.
3. Implement 5F.6M controlled return messaging after send/timeline canonicalization is stable.
4. Replace offset pagination with keyset pagination once volume grows or live sync begins.

## Beta Readiness Assessment

Current beta completion estimate:

```text
68%
```

Working beta foundation:

- Canonical store
- Archive-wide mailbox read model
- Archive-wide smart counts in RPC mode
- Search/filter/pagination in RPC mode
- Historical backfill chunks
- Latest sync foundation
- Context builder
- AI classification
- AI drafting
- Manual composer
- Controlled sending
- Operations dashboard

Remaining blockers:

- Stale asset cutover risk.
- Sync counter and sync-path ambiguity.
- Provider read/unread model missing.
- Post-send canonical timeline gap.
- Classification/reclassification scope ambiguity.
- Dashboard count exactness and operational validation gaps.
- Return messaging not implemented.
- Live sync not implemented.

Required stabilization work before feature development:

```text
1. Fix operator-facing truth labels and stale asset deployment risk.
2. Add a repeatable read-only regression gate.
3. Reconcile sync/latest/backfill/timeline status semantics.
4. Decide and implement post-send canonical message persistence.
5. Build provider-aware read/unread state before 5F.6P.
```

## Final Source-Of-Truth Decision

The current system should be treated as:

```text
Recovered from the canonical mailbox incident.
Not yet beta-ready.
Stable enough for a narrow stabilization sprint.
Not stable enough for new feature development until Priority 1 is complete.
```

The next engineering step should not be 5F.6P or 5F.6M. It should be a short 5F.6S stabilization implementation that addresses the Priority 1 items above and creates the Priority 2 regression gate.
