# Step 4E.1 - Controlled Outlook Sync Expansion Audit

Date: 2026-05-23

Scope: full audit only. No sync logic, Outlook behavior, schema, migrations, imports, filters, queues, or draft generation behavior were changed.

## Current Architecture

The durable Outlook sync path is centered on `supabase/functions/microsoft-email-sync/index.ts`.

Current sync is Microsoft Graph folder-delta based, not a simple latest-message fetch. The sync function uses:

```text
/me/mailFolders/{provider_folder_id}/messages/delta
```

with `Prefer: IdType="ImmutableId"` and a broad `$select` that includes message metadata, participants, preview, and full `body`. The initial URL is built in `initialDeltaUrl()`, while later incremental runs use `email_sync_states.delta_link` when present.

Supported sync modes are:

- `initial_backfill`
- `incremental`
- `manual_resync`

Input defaults matter operationally:

- missing or invalid `mode` defaults to `initial_backfill`
- only `folder = inbox` is accepted
- `maxPages` is clamped to `1..5`
- `pageSize` is clamped to `1..50`

The current hard upper bound per sync invocation is therefore 250 Graph items. Repeated invocations can continue a partial sync through the saved continuation link.

Sync lifecycle is persisted:

- `email_sync_runs` records a run per invocation, including counters and final status
- `email_sync_states` stores current status, `delta_link`, `delta_token_hash`, last attempt/success timestamps, error state, and continuation metadata
- `email_mailboxes.last_sync_at` is updated only when a final delta checkpoint is saved
- `microsoft_mailbox_connections` is updated for connection health and token refresh state

Delta checkpoint handling is conservative. A new `delta_link` is saved only when Graph returns final `@odata.deltaLink`. If page cap is reached before a checkpoint, the state remains `syncing`, previous checkpoint is preserved, and a private continuation link is stored in `email_sync_states.metadata`.

Persistence is immediate and local:

- active messages are inserted/updated in `email_messages`
- recipients are delete-replaced in `email_message_recipients`
- bodies are upserted in `email_message_bodies`
- Graph tombstones mark messages as `sync_status = tombstone`
- attachments are not downloaded or inserted into `email_attachments`; only `has_attachments` and counters are recorded

Duplicate prevention exists at multiple levels:

- database uniqueness on `(mailbox_id, provider_message_id)`
- database uniqueness on `(mailbox_id, provider_immutable_id)` where present
- database uniqueness on `(mailbox_id, internet_message_id)` where present
- code first looks up by provider message id, then falls back to `internetMessageId`
- processing jobs use unique `(message_id, job_type, input_version)`
- links use a unique dedupe index over message, link target, and status
- classifications dedupe by valid `input_hash` for classifier/version/input

Mailbox/folder configurability is intentionally minimal. Bootstrap creates one active Microsoft mailbox and one Inbox folder sync state. The sync function rejects non-Inbox folders and also rejects multiple active mailboxes.

## Existing Safety Controls

Strong controls already exist:

- All main email Edge Functions require Supabase auth plus active admin role.
- Supabase function config has `verify_jwt = true` for sync, process, classify, ops, bootstrap, mailbox status, and disconnect.
- Graph access, refresh-token decryption, token rotation, and delta links stay server-side.
- Sync has hard `maxPages` and `pageSize` caps.
- Delta checkpointing avoids overwriting a good checkpoint during partial paging.
- Continuation links are not returned to the browser.
- Safe logs avoid raw bodies, tokens, Graph payloads, and delta links.
- Sync does not enqueue processing, classification, or drafts.
- Draft generation is manual in the admin UI; the UI button calls `generate_response`/`regenerate_response`.
- Draft approval does not send email and does not mutate Outlook.
- Operational diagnostics exist through `microsoft-email-ops`: mailbox health, sync status, processing queue status, matching statistics, replay, requeue, and sync replay.
- Replay/requeue modes require a reason and write `email_operational_events`.
- Replay/requeue guards skip active queued/running jobs for the same message/job type.

## Existing Risks

### Full-mailbox expansion risk

The function cannot import an entire mailbox in one call because it caps at 5 pages and 50 messages per page. However, it can import the entire Inbox over repeated calls because saved continuation links are automatically resumed for `initial_backfill` and `incremental`.

That behavior is correct for a sync engine, but unsafe for controlled expansion unless an operator-facing preview/approval layer exists. There is currently no persistent import plan, no batch target, no `last X emails` or `last X days` selector, and no explicit "stop after this approved expansion" guard.

### Non-eBay persistence risk

The sync function persists every message returned by the Inbox delta page. There is no sender/domain allowlist, no eBay-only Graph filter, and no local pre-persistence eBay heuristic.

Matching and classification can later identify eBay-related content, but filtering currently happens after persistence, if at all. This means a larger Inbox backfill will store non-eBay message metadata, participants, and message bodies in the email triage tables.

### Body storage and privacy risk

`MESSAGE_SELECT` includes `body`, and `upsertBody()` stores HTML or text body content plus normalized text. A large uncontrolled sync would persist full bodies for any Inbox message returned by Graph, not just eBay mail.

This is probably the biggest operational risk before expansion.

### Classification queue risk

Sync itself does not enqueue classification. Good.

The risky edge is `microsoft-email-classify`: missing or invalid `mode` defaults to `enqueue_and_process`, with default `limit = 25`. If an admin/script calls the function casually after a larger sync, it can enqueue and process the most recent active messages immediately. It is capped, but it does call OpenAI.

Classification enqueue selects active messages ordered by newest received date and has no eBay-only filter. The dry-run classifier also calls OpenAI and validates output, although it does not write classifications.

### Processing queue risk

`microsoft-email-process` also defaults to `enqueue_and_process`, default `limit = 50`, and default job types `normalize` and `match_order`. It does not call OpenAI and is less risky than classification, but it can enqueue/process non-eBay messages after a large sync. It may create skipped jobs and operational noise for irrelevant mail.

### Duplicate classification risk

Normal classification enqueue skips active queued/running classify jobs and uses a stable classifier input version. Existing valid classifications with the same input hash are skipped. That is good.

Replay classification intentionally uses an operation-specific input version. It skips active jobs but can create new classify jobs for already-classified messages by design. This is appropriate for replay, but large replay selectors need stronger previews before expansion.

### Duplicate draft risk

Drafts are not automatically queued after sync or classification. Generation happens through explicit `generate_response`/`regenerate_response` calls. Current Step 4D.7 stabilization reduced current-draft pollution risk.

Remaining expansion concern: if future bulk classification UI adds automatic draft generation, it would bypass the currently useful manual gate. Do not add that in Step 4E.

### Admin protection bypass risk

Direct browser/table writes are constrained by RLS and grants. Edge Functions use service role internally but require admin auth, except `microsoft-email-ops` also accepts service-role bearer token for service automation. That is acceptable for controlled jobs but any future cron/automation must be treated as privileged and should require explicit dry-run/approval settings.

### Sync-state pollution risk

Partial sync state is intentionally stateful. A failed or interrupted large expansion can leave `email_sync_states.status = syncing` with a continuation link. `resume_sync_replay` can resume it, but there is no operator-facing "cancel expansion", "clear continuation", or "show pending continuation scope" control.

Manual resync starts a fresh delta path and ignores saved continuation, but it does not delete existing messages. Used carelessly, manual resync can create a new full delta cycle and further expand persisted data.

## Current eBay Filtering Capability

There is no pre-persistence eBay filter.

There are eBay-oriented deterministic heuristics in `microsoft-email-process`, but they are matching heuristics, not mailbox-ingestion filters. The matcher extracts:

- eBay order numbers
- eBay item numbers
- transaction IDs
- return IDs
- tracking/label identifiers
- buyer usernames
- buyer emails, with masked eBay email handling
- internal labels/custom labels
- item title phrases

Those heuristics run after a message has already been stored and after `normalize`/`match_order` jobs are created. They can link messages to `ebay_orders`, `ebay_order_lines`, inventory items, sales, and return cases, but they are not sufficient to decide what the sync may persist.

Recommended future approach: hybrid filtering.

Use Graph filtering for coarse safe narrowing where reliable, then local preview heuristics before persistence:

- Graph date limits for `last X days` are appropriate for bounded expansion.
- Graph sender/domain filtering can reduce volume for known eBay sender domains, but should not be the only control because eBay messages can arrive from several domains and masked/reply addresses.
- Local filtering should inspect sanitized preview fields before persistence in dry-run/preview mode.
- Full body should not be fetched/stored until a message passes the preview filter or an operator explicitly imports it.

The safest design is a two-phase sync preview:

1. Fetch candidate metadata/previews only.
2. Show counts and sampled senders/subjects/reasons.
3. Persist only approved candidates.
4. Fetch/store full body only for approved messages.

## Current Processing Trigger Flow

After sync, nothing automatically triggers processing, classification, or drafts inside `microsoft-email-sync`.

Processing is manual/API-triggered through `microsoft-email-process`:

- `enqueue_only`
- `process_queued`
- `enqueue_and_process`
- `process_message`

Classification is manual/API-triggered through `microsoft-email-classify`:

- `enqueue_only`
- `process_queued`
- `enqueue_and_process`
- `process_message`
- `dry_run`
- `replay_classification`

Draft generation is manual/API-triggered through `microsoft-email-classify`:

- `generate_response`
- `regenerate_response`

The admin UI loads mailbox status and latest sanitized message previews, but it does not expose a durable sync expansion button. The classification UI exposes manual draft generation/regeneration per selected classification and clearly states that approval does not send email.

Current automatic vs manual summary:

- Latest message preview: automatic after connected status, but it uses `microsoft-latest-messages` and does not persist messages.
- Durable sync: manual/API only.
- Normalize/match jobs: manual/API only.
- Classification jobs: manual/API only.
- Draft generation: manual per selected classification/API only.
- Email sending/Outlook mutation: not implemented in this path.

## Recommended Sync Expansion Strategy

Build preview before persistence. This is the critical change.

The next implementation step should not simply raise `maxPages` or add bigger buttons around the existing delta sync. The current sync writes full bodies for every returned Inbox message. With a small mailbox sample that has been fine; with real mailbox volume it becomes a privacy and relevance problem.

Recommended architecture:

- Add a separate sync preview mode or separate preview function before any persisted import.
- Preview should retrieve only minimal Graph fields: id, immutable id, internetMessageId, subject, from/sender, receivedDateTime, bodyPreview, parentFolderId, categories, hasAttachments.
- Preview must not store messages, bodies, recipients, jobs, classifications, drafts, sync runs, or delta checkpoints.
- Preview should support `last X emails`, `last X days`, and `eBay-only` candidate modes.
- Preview should return counts by inclusion/exclusion reason, sender/domain summary, date range, and a small sample of candidates.
- Import should require an explicit approved preview token or operation id.
- Import should persist approved candidates only, then optionally queue normalize/match jobs in `enqueue_only` mode.
- Classification should remain a separate explicit action after queue health is checked.
- Draft generation should remain per-message/per-classification manual.

For eBay-only import, prefer a hybrid:

- Graph date and top limits bound the candidate universe.
- Known sender/domain allowlist narrows obvious eBay mail.
- Local heuristics catch eBay messages by subject/bodyPreview identifiers.
- Any uncertain messages stay preview-only unless manually approved.

Recommended local eBay evidence categories:

- sender/from domain matches known eBay domains
- subject/bodyPreview contains eBay order number pattern
- subject/bodyPreview contains eBay item/transaction/return identifiers
- sender/display name clearly indicates eBay
- bodyPreview contains eBay platform phrases tied to order, return, message, cancellation, refund, shipping, or account/security notices

Do not use deterministic order matching as the only eBay filter. Matching requires stored body/metadata and can be noisy on non-eBay mail. Use it after approved persistence.

## Recommended Rollout Sequence

1. Add read-only sync preview.
   - No persistence.
   - Metadata/preview fields only.
   - Supports last X emails, last X days, and eBay-only candidate mode.

2. Add preview diagnostics.
   - Count candidates, excluded messages, sender domains, date range, and heuristic reasons.
   - Include redacted/safe samples only.

3. Add controlled import from preview.
   - Require preview id or signed/hashed approval payload.
   - Import only candidate message ids from preview.
   - Keep page and message caps low initially.
   - Record operation event.

4. Keep post-import processing separate.
   - First import only.
   - Then `microsoft-email-process` in `enqueue_only` for approved messages.
   - Then process a small queued batch.
   - Then classification dry-run on a tiny approved subset.
   - Then classification enqueue/process in explicit small batches.

5. Add queue backpressure checks.
   - Block new import/process/classify operations if active queue counts exceed configured thresholds.
   - Surface queue health next to import controls.

6. Add replay safety.
   - Replay selectors should preview selected messages and expected job counts before insertion.
   - Require reason and idempotency key for large replay operations.

7. Expand limits gradually.
   - 10-message eBay-only preview/import.
   - 25-message eBay-only preview/import.
   - 7-day eBay-only preview/import.
   - 30-day eBay-only preview/import.
   - Only then consider non-eBay categories, if needed.

## Required New Controls

- Sync preview before persistence.
- Explicit import approval separate from preview.
- `last X emails` selector with hard upper cap.
- `last X days` selector with hard upper cap.
- eBay-only candidate mode.
- Sender/domain allowlist and exclusion summary.
- Local preview heuristics with reason codes.
- No-body preview mode.
- Optional body fetch only after candidate approval.
- Operation/audit event for preview and import decisions.
- Batch id or import run id to connect imported messages to an approved operation.
- Queue health gate before enqueue/process/classify.
- Separate controls for import, normalize/match, classify, and draft.
- Dry-run classification wording should be clear that it calls OpenAI but does not write classifications.
- UI/API default modes should be explicit; avoid defaulting to `enqueue_and_process` for expanded controls.
- Diagnostics for partial sync continuation state, including "what happens if resumed".
- Admin-visible non-eBay persisted count after each import.
- Historical pollution checks for non-eBay imports and body persistence.

## What Should NOT Be Done

- Do not simply increase `maxPages` or `pageSize`.
- Do not add a "sync all" button.
- Do not use `manual_resync` as the controlled expansion mechanism.
- Do not persist full bodies before eBay filtering/approval.
- Do not classify every newly synced message automatically.
- Do not generate drafts automatically after sync or classification.
- Do not rely only on Graph sender filters for eBay-only import.
- Do not rely only on post-persistence matching to decide what belongs in the triage dataset.
- Do not clear or overwrite delta state casually to restart imports.
- Do not treat classifier `dry_run` as a cheap preview; it calls OpenAI.
- Do not introduce bulk replay without a preview and queue/backpressure gate.

## Proposed Revised Step 4E Plan

The original high-level goal is right: controlled Outlook sync expansion with last X emails, last X days, dry-run preview, controlled processing, eBay-first import, idempotency, and no blind drafts.

The unsafe part would be implementing that by expanding the existing delta sync directly. The existing sync is designed as a durable mailbox sync engine, not a filtered import planner. It persists every Graph delta message and stores body content.

Revised Step 4E should be:

### Step 4E.2 - Read-Only Sync Preview

Add a preview-only endpoint/mode that fetches bounded Graph message metadata/previews and returns candidate counts. It must not write database rows or delta checkpoints.

### Step 4E.3 - eBay Candidate Heuristics

Add local preview heuristics and reason codes for eBay-only candidate selection. Keep them separate from deterministic order matching.

### Step 4E.4 - Approved Import

Persist only messages approved from a preview. Fetch/store body only for approved candidates. Write an operational event with selector, counts, and reasons.

### Step 4E.5 - Post-Import Processing Gate

Add explicit operator controls to enqueue/process `normalize` and `match_order` for imported messages only, with queue health checks.

### Step 4E.6 - Classification Gate

Add explicit classification preview/queue controls for imported messages only. Start with tiny batches. Keep drafts manual.

### Step 4E.7 - Runtime Diagnostics

Add diagnostics for preview/import counts, non-eBay persisted count, active queue pressure, partial sync continuation state, and replay selectors.

### Step 4E.8 - Limit Expansion

Only after preview/import/processing/classification gates are proven should limits increase beyond the current small dataset.

## File Anchors Reviewed

- `supabase/functions/microsoft-email-sync/index.ts`
- `supabase/functions/microsoft-email-process/index.ts`
- `supabase/functions/microsoft-email-classify/index.ts`
- `supabase/functions/microsoft-email-ops/index.ts`
- `supabase/functions/microsoft-email-bootstrap/index.ts`
- `supabase/functions/microsoft-latest-messages/index.ts`
- `email-triage.js`
- `email-triage.html`
- `supabase/migrations/20260520143000_email_triage_persistence_foundation.sql`
- `supabase/migrations/20260520170000_email_triage_operational_events.sql`
- `supabase/migrations/20260520193000_email_triage_classification_schema_foundation.sql`
- `supabase/config.toml`

