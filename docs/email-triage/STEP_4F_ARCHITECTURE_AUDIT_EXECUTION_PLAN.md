# Step 4F - Architecture Audit and Execution Plan

Date: 2026-05-24

Scope: architecture audit and execution planning only. No frontend code, backend code, database schema, migrations, scheduler behavior, Outlook behavior, classification behavior, draft behavior, or queue behavior was changed.

## Executive Summary

Step 4E successfully moved the OG Outlook Email Triage system from a narrow backend orchestration prototype into a controlled, replay-aware operational backend. The system now has safe Outlook preview/import behavior, deterministic processing, controlled classification, diagnostics, replay/requeue controls, rollout gates, and a live sync eligibility flag.

The next phase, Step 4F, should not simply add more buttons to the current page or more modes to the current Edge Functions. The current system is safe, but the major architectural pressure is that the frontend and backend control surfaces are now carrying too many responsibilities in large single files:

- `email-triage.js` is already a full admin app in one file.
- `microsoft-email-sync` now mixes Graph preview, approved import, deterministic processing orchestration, classification gating, rollout status, live sync toggles, and pipeline diagnostics.
- `microsoft-email-classify` now mixes classifier execution, admin list views, message detail views, match review, response draft generation, draft review, classification replay, and draft diagnostics/repair tools.

Those choices were reasonable while proving Step 4E. They are not sustainable for a production-style operational admin system.

Recommended Step 4F direction:

1. Add a short Step 4F.0 before new live execution work.
2. Standardize UI/backend contracts for paginated lists, operations, diagnostics, replay visibility, and safety metadata.
3. Modularize the frontend around operations, inbox preview/import, classifications, drafts, diagnostics, and shared API/state utilities.
4. Keep manual live sync operator-triggered and bounded, but implement it as a staged orchestration with visible child results and a parent operational event.
5. Move scheduled polling later, after manual live operation records, queue bounds, failure recovery, and dashboard visibility are proven.

The current safety model should remain intact:

- no auto-send
- no Outlook mutation
- no autonomous polling
- no automatic draft generation from live sync
- operator-triggered only
- replay-safe
- queue-protected
- bounded
- diagnostics-visible

## Inspected Files and Architecture

Primary files inspected:

- `email-triage.html`
- `email-triage.js`
- `supabase/functions/microsoft-email-sync/index.ts`
- `supabase/functions/microsoft-email-classify/index.ts`
- `supabase/functions/microsoft-email-process/index.ts`
- `supabase/functions/microsoft-email-ops/index.ts`
- `supabase/functions/microsoft-mailbox-status/index.ts`
- `supabase/functions/microsoft-latest-messages/index.ts`

Relevant schema and migration areas inspected:

- email mailbox, folder, message, body, recipient, attachment, sync state, sync run, processing job, classification, and link tables
- operational event table
- classification review override schema
- response draft persistence schema
- import approval operational event schema additions
- classify imported operational event schema additions
- live sync enablement toggle

Relevant docs inspected:

- `STEP_4E_SYNC_EXPANSION_AUDIT.md`
- `STEP_4A_OPERATIONS_REPLAY.md`
- `STEP_4B_CLASSIFICATION_VALIDATION_REPLAY.md`

## Current Step 4E State

The backend has a mature controlled pipeline:

- Outlook preview is safe and does not persist full message bodies.
- Preview bucketing supports likely, maybe, and not eBay buckets.
- Sender/domain and reason-code diagnostics exist.
- Approved imports require operator intent.
- Full body fetch occurs only after import approval.
- Import writes replay-safe operational events.
- Deterministic processing normalizes messages and attempts order matching.
- Processing jobs are queue-protected and replay-safe.
- Classification is controlled, batch-bound, and queue-protected.
- Classification replay uses operation-specific jobs and operational events.
- Rollout diagnostics, pipeline diagnostics, queue diagnostics, and live sync status exist.
- `live_sync_enabled` exists as an eligibility flag only.

The current frontend already includes more than a simple proof-of-connection:

- Outlook connection status
- raw latest message preview
- classification inbox layout
- category sidebar
- filters and sorting
- density and panel sizing state
- selected classification detail view
- message body fetch
- operator classification review/override
- deterministic match context
- match confirm/reject/stale actions
- response draft generation/regeneration
- draft edit/save/approve/reject
- draft history and safety diagnostics
- admin summary metrics

This means some proposed Step 4F UI items are not purely future work. They already exist partially, but they are coupled into one large file and one classification-centric screen.

## Frontend Architecture Audit

### Current Structure

`email-triage.html` is a static admin page using existing dashboard shell conventions. It loads:

- Tabler CSS from CDN
- Google font
- `dashboard.css`
- `email-triage.css`
- Lucide icons
- Supabase client
- `initSupabase.js`
- `admin-nav.js`
- `email-triage.js`

`email-triage.js` is a self-contained IIFE. It owns:

- DOM references
- local storage layout preferences
- admin auth guard
- Edge Function transport
- status rendering
- mailbox connection controls
- latest Outlook preview rendering
- classification admin view fetch
- classification normalization
- sorting/filtering logic
- selected classification state
- rendering for list/detail/sidebar
- message detail fetch
- draft view fetch
- draft generation/regeneration
- draft review actions
- match context fetch
- match review actions
- classification review save
- all event binding

This is now an application, not a script.

### Sustainability Assessment

`email-triage.js` should not continue growing in its current shape.

Current problems:

- API calls are duplicated with similar auth/session/timeout handling.
- State is mutable object state with broad rendering side effects.
- Render functions are long and interdependent.
- UI concepts are classification-centric even though Step 4F needs inbox, queue, diagnostics, dashboard, and live operations views.
- Filtering and sorting are currently frontend-local against limited result sets.
- There is no formal list pagination state.
- Refresh behavior is manually coordinated by ad hoc function calls.
- Diagnostics are partly hidden behind admin/debug panels.
- Draft, classification, match, and mailbox concerns are tightly coupled.

Current strengths:

- The page already has a mature admin-only auth pattern.
- It has safe HTML escaping utilities.
- It has practical UI patterns for badges, disclosures, detail panels, and action buttons.
- It has proven operator flows for classification/draft/match review.
- It avoids hidden auto-send behavior and reports draft safety state clearly.

### Recommended Frontend Direction

Keep the static no-build approach for the next step unless the broader app is ready for a build system. Split the JavaScript into small plain-browser modules or ordered scripts.

Recommended structure:

```text
email-triage/
  api.js
  state.js
  render-utils.js
  constants.js
  views/
    mailbox-status.js
    inbox-preview.js
    imported-messages.js
    processing-queue.js
    classification-review.js
    draft-review.js
    diagnostics.js
    dashboard.js
  actions/
    live-sync-actions.js
    import-actions.js
    review-actions.js
    draft-actions.js
```

If keeping files in repo root is preferred for now, use prefixes:

```text
email-triage.api.js
email-triage.state.js
email-triage.render-utils.js
email-triage.inbox.js
email-triage.classifications.js
email-triage.drafts.js
email-triage.diagnostics.js
```

Recommended state approach:

- Use a small local store/reducer, not a heavy framework.
- Track active tab/view, mailbox status, live sync status, selected message/classification/draft IDs, filters, pagination cursors, in-flight operations, and last operation results.
- Use explicit state transitions such as `LOAD_PREVIEW_STARTED`, `LOAD_PREVIEW_SUCCEEDED`, `IMPORT_APPROVED_SUCCEEDED`, `RUN_LIVE_SYNC_STARTED`, `RUN_LIVE_SYNC_FAILED`.
- Keep view rendering functions pure where possible: state in, HTML out.

Recommended polling strategy:

- Use manual refresh first.
- Use short-lived polling only while an operator-triggered operation is in progress.
- Poll operation status/queue status every few seconds during active processing.
- Stop polling when queues reach terminal/idle state or operation result is resolved.
- Avoid Supabase Realtime in Step 4F.1 unless there is already a stable cross-app pattern. Realtime can come later for queue/event tables.

Recommended refresh synchronization:

- Use a central `refreshOperationalSnapshot()` that refreshes mailbox status, live sync status, queue summary, latest operation, and visible list counters.
- After any mutating action, refresh only affected slices first, then update the top operational snapshot.
- Surface stale data clearly with `last_refreshed_at`.
- Prevent duplicate action clicks while an operation is in flight.

Recommended pagination:

- Move to server-side pagination before broadening the UI.
- Prefer cursor pagination based on stable pairs:
  - inbox/imported messages: `(received_at, id)`
  - jobs/events/drafts/classifications: `(created_at, id)` or `(updated_at, id)`
- Avoid offset pagination for fast-changing queues.
- Include `limit`, `next_cursor`, `has_more`, and `total_estimate` where useful.

Recommended filtering/search:

- Filters should be backend contracts, not only frontend transforms.
- Initial filters:
  - bucket
  - import status
  - processing status
  - classification status
  - classification category
  - review state
  - draft status
  - queue status
  - sender/domain
  - date range
  - search text
- Search should start simple: subject, sender, preview/body snippet where safe, reason codes, order numbers.

Recommended table/list scalability:

- Do not render unbounded lists.
- Use paginated list panels with stable row heights where possible.
- Use detail panes for heavy content such as body, match context, draft history, and diagnostics.
- Keep body/draft content lazy-loaded.
- Avoid fetching draft body content for every row.

Recommended replay and diagnostics UX:

- Make replay operations visible as first-class operational history, not hidden debug details.
- For each operation show:
  - event type
  - operation id
  - actor
  - reason
  - selected message/job count
  - skipped active count
  - new job count
  - queue impact
  - created timestamp
  - safety summary
- Provide "copy operation id" style affordances later if useful.

## Backend and API Architecture Audit

### Current Backend Shape

`microsoft-email-sync` currently handles:

- durable sync modes: `initial_backfill`, `incremental`, `manual_resync`
- `sync_preview`
- `sync_import_approved`
- `process_imported`
- `classify_imported`
- `pipeline_diagnostics`
- `rollout_status`
- `live_sync_status`
- `set_live_sync`

`microsoft-email-classify` currently handles:

- classifier queue modes
- `dry_run`
- `replay_classification`
- `admin_view`
- `message_detail`
- `admin_context_view`
- `operator_match_context`
- match confirm/reject/stale
- `save_review`
- response draft generation/regeneration
- `admin_draft_view`
- draft diagnostics
- draft repair
- draft review save/approve/reject

`microsoft-email-process` handles deterministic processing execution.

`microsoft-email-ops` handles mailbox health, sync status, processing queue status, matching statistics, requeue, processing replay, and sync replay.

### Is `microsoft-email-sync` Too Overloaded?

Yes for the future production admin system.

It is acceptable for Step 4E because it kept the controlled import/process/classify pipeline close to the preview/import flow. It becomes risky in Step 4F because the proposed `run_live_sync` would add orchestration on top of an already mixed function.

The main concern is conceptual clarity:

- Sync should own Graph interaction and persistence.
- Processing should own deterministic job execution.
- Classification should own classifier job execution.
- Operations should own queue/replay/diagnostics.
- Admin read models should serve UI lists.
- Orchestration should coordinate child operations without burying them.

### Is `microsoft-email-classify` Too Overloaded?

Yes.

It now owns classifier execution, admin UI read models, operator review, match review, response draft generation, draft review, and diagnostic repair. Those are related but operationally distinct.

Immediate split is not required before Step 4F.1, but new features should avoid adding more admin list/read-model modes into this function unless they are very small.

### Recommended Future API Organization

Ideal future functions:

```text
microsoft-email-sync
  Graph preview/import/durable checkpoint sync only

microsoft-email-process
  deterministic normalize/match job executor only

microsoft-email-classify
  classify job enqueue/process/dry-run/replay only

microsoft-email-drafts
  response draft generation, draft view, draft save/approve/reject

microsoft-email-ops
  mailbox health, sync status, queue status, operational events, replay/requeue

microsoft-email-admin-view
  paginated UI read models for inbox, imported messages, classifications, drafts, jobs, events

microsoft-email-live-run
  manual operator-triggered orchestration wrapper
```

Safe transition path:

1. Do not split all existing functions immediately.
2. Define response contracts and pagination/filter conventions first.
3. Add any new Step 4F read model to a new admin-view or ops function rather than expanding classify/sync.
4. Add `run_live_sync` as an orchestration wrapper only after inbox preview/import UI and contracts are stable.
5. Later move draft-specific modes from classify into a draft function.

### Manual Live Refresh Execution Recommendation

The proposed `mode: "run_live_sync"` should not be implemented as a simple hidden chain that does everything and returns only final counters.

It should behave as a staged operation:

1. Validate operator and mailbox.
2. Require `live_sync_enabled = true`.
3. Validate rollout controls.
4. Validate queue capacity.
5. Create a parent operational event or live operation run record.
6. Run preview with explicit caps.
7. Import only approved rule-eligible messages.
8. Run deterministic processing for imported candidates within caps.
9. Run classification for deterministic-complete candidates within caps.
10. Return child operation references and counters.

It must preserve:

- no auto-send
- no Outlook mutation
- no autonomous polling
- no automatic draft generation
- no hidden checkpoint mutation unless the mode explicitly uses durable sync and reports it

If the operation uses preview/import rather than durable delta sync, the response must clearly say `sync_checkpoint_updated: false`.

If a future mode uses durable incremental sync, it should be separately named or clearly separated from preview/import live refresh because durable checkpoint semantics are different.

## Queue and Replay Architecture Audit

### Current Strengths

The current replay model is one of the strongest parts of the system:

- Operational actions write immutable `email_operational_events`.
- Replay/requeue requires reasons.
- Replays create new jobs with operation-specific `input_version`.
- Historical jobs and classifications are preserved.
- Active queued/running jobs are skipped.
- Import and classify gates record operation events.
- Safety counters are explicit.
- Queue saturation protections exist.
- Batch caps exist.

### Current Weaknesses

Potential issues before scheduled or concurrent execution:

- Job claiming is primarily function-level. A future multi-worker scheduler should use atomic database claim RPCs.
- Queue tables can grow indefinitely without retention or archival policy.
- Operational event payloads are flexible but not formally versioned.
- Event type check constraints have been repeatedly widened. This is manageable now but brittle as event types increase.
- Some diagnostics summarize the latest limited set rather than a true paginated history.
- Parent/child operation relationships are not yet formalized for a multi-stage live run.

### Future Bottlenecks

Likely scaling pressure points:

- `email_processing_jobs` status scans as jobs grow.
- Classification list queries without mailbox/date/review filters.
- Operational event table growth.
- Repeated count queries for dashboard widgets.
- Large message body/detail reads from admin UI.
- Classification/draft workflows sharing one large function and one UI screen.

### Scheduler Compatibility Requirements

Before scheduled polling:

- Create parent operation/run records.
- Add atomic queue claim RPCs or equivalent.
- Add idempotency keys for scheduled operation windows.
- Add operation lease/timeout handling.
- Add paused/disabled states visible in UI.
- Add backoff on repeated failures.
- Add queue depth and age thresholds.
- Add retention/archive policy for jobs/events.
- Add dashboard recovery controls.

## UI and Backend Contract Recommendations

### Standard Response Envelope

All Step 4F operational APIs should return a consistent envelope:

```json
{
  "ok": true,
  "mode": "operation_name",
  "request_id": "uuid",
  "operation_id": "uuid_or_null",
  "generated_at": "2026-05-24T00:00:00.000Z",
  "data": {},
  "page": {
    "limit": 50,
    "next_cursor": null,
    "has_more": false
  },
  "counters": {},
  "safety": {
    "outlook_mutation_performed": false,
    "automatic_responses_sent": 0,
    "drafts_created": 0,
    "sync_checkpoint_updated": false,
    "attachments_fetched": 0
  }
}
```

Error envelope:

```json
{
  "ok": false,
  "mode": "operation_name_or_unknown",
  "request_id": "uuid",
  "error": "safe_error_code",
  "phase": "safe_phase",
  "retryable": false,
  "operator_message": "Safe human-readable summary."
}
```

### Pagination Contract

Recommended list request:

```json
{
  "mode": "list_imported_messages",
  "limit": 50,
  "cursor": null,
  "filters": {
    "status": ["active"],
    "date_from": null,
    "date_to": null,
    "search": null
  },
  "sort": {
    "field": "received_at",
    "direction": "desc"
  }
}
```

Recommended list response:

```json
{
  "ok": true,
  "mode": "list_imported_messages",
  "rows": [],
  "page": {
    "limit": 50,
    "next_cursor": "opaque_cursor_or_null",
    "has_more": false
  },
  "summary": {
    "total_estimate": null
  }
}
```

### Filtering Contract

Filters should be explicit, typed, and conservative:

- `mailbox_id`
- `bucket`
- `import_status`
- `processing_status`
- `classification_status`
- `review_state`
- `draft_status`
- `job_type`
- `job_status`
- `event_type`
- `date_from`
- `date_to`
- `sender_domain`
- `search`

Avoid passing raw SQL-like filter strings from the frontend.

### Replay Visibility Contract

Operational/replay rows should include:

- `operation_event_id`
- `event_type`
- `created_at`
- `initiated_by_email`
- `reason`
- `replay_source`
- `message_count`
- `job_count`
- `new_job_count`
- `skipped_active_count`
- `job_types`
- `payload_summary`
- `safety`

### Diagnostics Contract

Diagnostics should be split by scope:

- mailbox health
- sync health
- preview/import health
- processing queue health
- classification health
- draft health
- replay/event health
- rollout/live sync controls

Each diagnostic response should include:

- `status`: `ok`, `warning`, `blocked`, or `error`
- `summary`
- `counters`
- `latest_event`
- `recommended_next_action`
- `safe_to_run`
- `blocking_reasons`

## Operational UX Audit

### Current Operator Workflow

Current workflow is safe but still DevTools/admin-heavy in places:

- Connect mailbox from UI.
- Load latest raw sanitized messages.
- Use classification admin view as primary inbox.
- Review selected classification.
- Open full message body on demand.
- Inspect matched order context.
- Confirm/reject/stale deterministic matches.
- Save classification review/override.
- Generate/regenerate response drafts manually.
- Edit/save/approve/reject drafts manually.

### UX Risks

- The main page label still reads partly like proof-of-connection while the page behaves like an operational console.
- Critical status is split between mailbox toolbar, admin drawer, system metrics, and classification summary.
- Import/processing/classification pipeline progression is not visible as one operator workflow.
- Queue health is not prominent enough for a production operator.
- Replay/event history is not a first-class workflow artifact.
- Classification and draft UI exists, but inbox preview/import UI does not yet match its maturity.

### Recommended Operator Workflow

Recommended Step 4F operator path:

1. Operator lands on an operational dashboard, not a raw proof-of-connection page.
2. Top status shows mailbox connection, live sync eligibility, last operation, queue pressure, and failures.
3. Operator opens Preview Queue.
4. Operator runs preview/refresh.
5. UI shows likely/maybe/not eBay buckets, reason codes, sender/domain summary, and existing import status.
6. Operator imports selected messages or all likely eBay.
7. UI shows import results, skipped reasons, operation id, and next recommended action.
8. Operator runs deterministic processing for imported messages.
9. UI shows normalize/match queue state and failures.
10. Operator runs bounded classification for processed messages.
11. UI shows classification results and review queue.
12. Operator reviews classifications and drafts.
13. Failures show replay/requeue actions that require reason.

### Safety UX Requirements

Every operator action that changes state should show:

- what will happen
- what will not happen
- batch cap
- queue state
- operation id after execution
- child operation references where relevant

For live sync:

- Button disabled unless `live_sync_enabled = true`.
- Button disabled or warning if queue is saturated.
- Confirmation text should mention no sending and no Outlook mutation.
- Result should show imported count, processed count, classified count, skipped count, failed count, queue state, and operation id.

## Sequencing Review

Original proposed sequence:

1. Manual live refresh execution
2. Inbox review UI
3. Classification review UI
4. Draft review UI
5. Operational dashboard
6. Scheduled polling later

Recommended adjusted sequence:

1. Step 4F.0: contracts and frontend architecture foundation
2. Inbox preview/import UI
3. Manual live refresh execution
4. Operational dashboard basics
5. Classification review UI refinement
6. Draft queue UI refinement
7. Scheduled polling later

Reasoning:

- Manual live refresh should not precede the UI and contract work needed to make its staged effects visible.
- Inbox preview/import is the main missing operator workflow.
- Classification and draft review already exist partially, so refinement can come after the missing inbox/import surface.
- Dashboard should move earlier than draft queue polish because live execution requires queue/failure visibility.
- Scheduled polling remains correctly last.

## Recommended Step 4F Roadmap

### Step 4F.0 - Contract and UI Architecture Foundation

Purpose:

- Prevent frontend/backend drift before the UI grows.
- Stop `email-triage.js` from becoming harder to change.

Deliverables:

- Document standard response envelopes.
- Document list/pagination/filter contracts.
- Add frontend API helper module.
- Add frontend store/reducer module.
- Add shared render utilities.
- Keep behavior unchanged during this foundation step.

No behavior changes:

- no new sync mode
- no new scheduler
- no Outlook mutation
- no auto-send
- no automatic drafts

### Step 4F.1 - Inbox Preview and Import UI

Purpose:

- Replace DevTools-heavy preview/import workflow with real operator controls.

Deliverables:

- Preview Queue section.
- Likely/maybe/not eBay tabs or filters.
- Reason-code badges.
- Sender/domain diagnostics.
- Already imported visibility.
- Import Selected.
- Import All Likely eBay.
- Maybe review path.
- Ignore/non-eBay path as UI state first, persistent marking later if needed.
- Import result panel with operational event id.

### Step 4F.2 - Manual Live Refresh Execution

Purpose:

- Provide one operator-triggered bounded operation that coordinates current safe stages.

Required behavior:

- Require `live_sync_enabled = true`.
- Check rollout controls.
- Check queue capacity.
- Run only bounded stages.
- Produce parent operation record.
- Return child stage summaries.
- Do not send.
- Do not mutate Outlook.
- Do not autonomously poll.
- Do not generate drafts automatically.

Recommended response fields:

- `operation_id`
- `live_sync_enabled`
- `previewed_count`
- `imported_count`
- `processed_count`
- `classified_count`
- `skipped_count`
- `failed_count`
- `queue_state`
- `child_operations`
- `safety`

### Step 4F.3 - Operational Dashboard Basics

Purpose:

- Make live execution safe to operate repeatedly.

Widgets:

- mailbox connection health
- live sync eligibility
- last live operation
- import counts
- queue pressure
- oldest queued job age
- failed jobs
- classification review backlog
- draft safety backlog
- replay/requeue history

### Step 4F.4 - Classification Review Refinement

Purpose:

- Turn existing classification admin view into a scalable review workflow.

Deliverables:

- Server-side pagination.
- Backend filters.
- Review state tabs.
- Low confidence/safety filters.
- Bulk triage summaries, not bulk corrections.
- Review history visibility.

### Step 4F.5 - Draft Queue Refinement

Purpose:

- Turn per-message draft review into a queue-level workflow.

Deliverables:

- Draft queue list.
- Draft status filters.
- Safety flag filters.
- Draft version history.
- Edit/save/approve/reject flow.
- Regenerate flow.

Still prohibited:

- no auto-send
- no Outlook mutation
- no automatic production draft generation from live sync

### Step 4F.6 - Scheduled Polling Later

Purpose:

- Add autonomous execution only after manual operational model is proven.

Prerequisites:

- stable manual live run
- parent operation records
- queue saturation controls
- atomic job claim strategy
- dashboard visibility
- replay/requeue recovery UX
- failure backoff
- pause/disable controls
- retention/archive policy

## Recommended Immediate Next Executable Step

The next executable step should be Step 4F.0:

1. Create the API contract document or section.
2. Refactor `email-triage.js` into safe modules without changing behavior.
3. Add a central API wrapper and response normalization.
4. Add a small state/reducer module.
5. Preserve current classification/draft/match functionality.
6. Do not add `run_live_sync` until the inbox/import UI and operation contracts are ready.

This is the safest bridge from backend orchestration prototype to production-style operational admin system.

## Implementation Guardrails for Step 4F

Do not implement any of the following during Step 4F unless explicitly approved in a later step:

- automatic sending
- Outlook mutation
- scheduler/cron/autonomous polling
- automatic production draft generation
- broad full-mailbox persistence
- unbounded classification
- hidden replay/requeue actions
- direct browser writes to service-role-only operational tables
- frontend-only pagination for production lists

Preserve:

- operator-triggered execution
- bounded batches
- replay-safe events
- queue protections
- rollout controls
- admin auth
- safe diagnostics
- no token/body leakage in logs or diagnostics

