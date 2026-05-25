# STEP 5 - Email Triage Beta Readiness Acceleration Audit

Status: Audit only  
Phase: 5A - Beta Readiness Audit  
Date: 2026-05-25  
Primary source of truth reviewed: `docs/email-triage/STEP_4F_FULL_EMAIL_TRIAGE_ARCHITECTURE_AUDIT.md`  
Implementation status: No code changes, migrations, deploys, Outlook mutations, eBay mutations, send scopes, or send behavior in this step.

## 1. Executive Summary

The Email Triage system is no longer blocked by broad prototype instability. The core data model, Outlook import path, email processing jobs, deterministic eBay matching, AI classification, draft generation, admin UI, telemetry, current-valid classification filtering, and staleness detection all exist.

The system is still not beta-ready because it behaves like a pipeline console instead of an operator mailbox.

For internal beta, the operator expectation is simple:

```text
Import emails -> emails become processed, matched, classified, and visible in a mailbox.
```

Current behavior is different:

```text
Preview Outlook Emails -> Import Likely Only -> imported rows persist, then stop.
```

That is beta-critical. Importing does not reliably mean emails become usable mailbox messages. Live refresh does chain import, process, and classify, but current caps mean it cannot complete a 100-email import in one pass, and it is nowhere near a 1,000-email mailbox bootstrap.

The shortest safe path to functional internal beta is:

1. Add a mailbox-scale import/backfill flow that can page Outlook emails toward a 1,000-email target without trying to fetch/import all 1,000 in one synchronous request.
2. Replace normal operator-facing "Import Only" semantics with "Import + Prepare Mailbox" semantics that drain processing, deterministic matching, and classification until the imported emails are usable or failures are visible.
3. Add backend-backed pagination/load-more and category-aware fetching so totals always map to navigable rows.
4. Separate rematch controls from preview/import controls and make rematch scope explicit.
5. Improve full email display from raw flattened text to a conversation-like view using stored body text/html, conversation IDs, recipients, sender metadata, dates, and message boundaries.
6. Harden draft review UX so approved means "ready for human send", not "sent".
7. Design and later implement Outlook send as a separate explicit human-approved workflow with new Graph scopes, idempotency, audit records, and no autonomous sending.

Recommended immediate next executable step:

```text
5B - Mailbox Scale Foundation: Import 1,000 + Durable Batch Progress
```

However, 5B should be designed with 5C in mind. Importing 1,000 emails without a completion path would only create a larger partial-state problem.

## 2. Current Blockers To Beta

### Must-fix blockers

1. No operator-safe 1,000-email import path.
   - Frontend preview limit options are currently 10, 25, and 100.
   - Backend preview/import/live refresh inputs clamp to 100.
   - Durable delta sync can page, but it is not currently exposed as a clear operator mailbox bootstrap that imports toward a 1,000-email target and then prepares those emails for mailbox use.

2. Normal import semantics stop too early.
   - `Import Likely Only` and `Import Selected Only` call the import endpoint and then stop.
   - The UI explicitly says imported emails are not processed/classified/rematched/drafted/sent.
   - That warning is accurate, but the workflow is not acceptable for beta mailbox UX.

3. Live refresh is not enough.
   - `Run Live Refresh` does chain import -> process -> classify.
   - It is gated by live sync enablement and rollout controls.
   - It imports up to 100, processes up to 25, and classifies up to 10 per invocation.
   - A 100-email import can still leave most imported emails not fully classified.

4. Processing/classification candidate pools are still too narrow for mailbox-scale completion.
   - Processing and classification are mostly driven from recent `sync_import_approved` events.
   - The system also has table-derived pipeline visibility, but candidate draining is not yet built around "all active imported mailbox messages that need work."

5. Mailbox navigation is capped and misleading.
   - Backend admin classification view clamps loaded classifications to 50.
   - Frontend may request more, but backend caps at 50.
   - Category totals can be exact while category row lists still only search the loaded slice.
   - A category can show rows exist, but clicking it cannot navigate to unloaded rows.

6. Rematch scope is unclear.
   - `Rematch Existing Emails` uses the same preview/import control values.
   - The operator cannot tell whether it rematches 25, 100, the preview window, loaded rows, or all imported messages.
   - Backend rematch also caps at 100.

7. Full email view is not mailbox-like.
   - It renders one raw/flattened normalized text block.
   - It does not visually separate buyer messages, previous operator replies, platform/system messages, or quoted history.
   - The database already stores enough data for a better beta view, but the current detail endpoint and UI do not use it.

8. Reply workflow is incomplete for beta if sending is in scope.
   - Draft generation, edit, approve, and reject exist.
   - Approval does not send, and the UI says so.
   - No Graph send/reply implementation exists.
   - Current OAuth scopes are read-only.

9. The UI exposes pipeline internals as primary workflow.
   - Operators see preview/import/process/rematch/classify concepts instead of mailbox concepts like Inbox, Needs Reply, Ready To Review, Sent, Failed, Load More, and Continue Import.

## 3. Import / Preview / Sync Scale Analysis

### Current implementation

Frontend:

- `email-triage.html`
  - Inbox preview limit selector offers `10`, `25`, and `100`.
  - Primary controls include `Preview Outlook Emails`, `Run Live Refresh`, `Rematch Existing Emails`, `Import Likely Only`, and `Import Selected Only`.
- `email-triage.inbox.js`
  - `importControlsFromState` reads the same preview controls for import, live refresh, and rematch.
  - `handlePreviewInbox`, `handleImportApprovedInbox`, `handleRunLiveRefresh`, and `handleRematchExistingEmails` all reuse nearby controls.
- `email-triage.api.js`
  - `previewInboxMessages` sends `mode: sync_preview`.
  - `importApprovedInboxPreview` sends `mode: sync_import_approved`.
  - `runInboxLiveRefresh` sends `mode: run_live_refresh`.
  - Frontend timeouts are 30 seconds for preview and 60 seconds for import/live refresh/rematch.

Backend:

- `supabase/functions/microsoft-email-sync/index.ts`
  - `PREVIEW_DEFAULT_LIMIT = 25`
  - `PREVIEW_MAX_LIMIT = 100`
  - `MAX_IMPORT_BATCH = 100`
  - `MAX_PROCESS_BATCH = 25`
  - `MAX_CLASSIFICATION_BATCH = 10`
  - Durable sync page size is capped at 50 and max pages at 5 per invocation, so a durable sync invocation can cover up to about 250 messages before continuation.
  - `sync_preview` calls Microsoft Graph messages with `$top=input.limit` and does not follow `@odata.nextLink`.
  - `sync_import_approved` previews and imports only the approved/likely IDs from that bounded window.
  - `run_live_refresh` previews/imports then processes/classifies bounded batches.
  - Durable delta sync code exists and supports `@odata.nextLink`/`@odata.deltaLink`, continuation, and sync state persistence.

### Practical issue

The current normal operator workflow can import at most 100 previewed messages per request. It cannot import 1,000 emails from the UI in a clear, safe, resumable way.

Trying to increase one synchronous preview/import limit to 1,000 is not the safest path because:

- Graph calls for full message details are performed per message.
- Edge Function duration may be exceeded.
- Browser requests may time out.
- Operator progress would be unclear.
- Partial import recovery would be poor.
- Classification and OpenAI calls are slower and more expensive than import.

### Fastest safe path to 1,000 emails

Use a paged mailbox bootstrap/backfill flow, not a single 1,000-message synchronous import.

Recommended beta behavior:

```text
Start mailbox import target: 100 / 300 / 1,000
Fetch/import one bounded Graph page batch
Persist imported messages idempotently
Return progress and continuation
Continue automatically or with a clear Continue button
After each imported batch, prepare imported emails for mailbox use
Stop at target, timeout budget, no more pages, or explicit cancel
```

Recommended backend approach:

1. Reuse durable delta sync infrastructure where possible.
   - Existing durable sync already knows how to follow Graph continuation links and persist sync state.
   - Avoid inventing a second pagination system unless current durable sync cannot be adapted quickly.

2. Add an operator-facing mode or wrapper for mailbox bootstrap.
   - Candidate names:
     - `mailbox_backfill`
     - `run_mailbox_import`
     - `run_mailbox_bootstrap`
   - This should be distinct from developer/admin replay modes.

3. Keep each invocation bounded.
   - Suggested initial page size: 50.
   - Suggested per-invocation max pages: 3 to 5.
   - Suggested target options: 100, 300, 1,000.
   - Return `has_more`, `continuation`, `imported_count`, `already_imported_count`, `skipped_count`, `failed_count`, and `target_remaining`.

4. Do not render a 1,000-row Outlook preview.
   - Preview can remain a small safety sample.
   - Mailbox bootstrap should be a progress workflow, not a giant selectable preview table.

5. Maintain idempotency with existing unique/provider IDs.
   - Existing imports upsert `email_messages`, bodies, recipients, attachments, eBay signals, and operational events.
   - Duplicate Graph messages should not create duplicate rows.

6. Avoid unnecessary migration churn.
   - First try to reuse `email_sync_runs`, `email_sync_states`, and existing operational event payloads.
   - Add a migration only if a new durable progress table or new event type is truly needed.

### Executable implementation steps for 5B

1. Inspect current durable sync call sites and determine whether an existing mode can safely serve as mailbox bootstrap.
   - File: `supabase/functions/microsoft-email-sync/index.ts`
   - Inspect: durable input parsing, Graph delta helpers, sync state persistence, import upsert helpers.

2. Add or expose a mailbox bootstrap action with explicit target count.
   - Inputs:
     - `targetCount`: 100, 300, or 1000
     - `pageSize`: default 50
     - `maxPages`: default 3 to 5
     - `mailFolderId`: default inbox
     - `daysBack`: optional and clearly labeled if retained
   - Outputs:
     - imported count
     - skipped count
     - duplicate/already imported count
     - failed count
     - continuation status
     - progress toward target

3. Add a frontend mailbox import control.
   - File: `email-triage.html`
   - File: `email-triage.inbox.js`
   - File: `email-triage.api.js`
   - Replace normal operator language with "Import Mailbox" / "Continue Import" / "Prepare Mailbox".
   - Keep small preview controls as optional/admin or secondary.

4. Increase frontend request timeout only for bounded continuation calls if needed.
   - File: `email-triage.api.js`
   - Do not mask long-running requests by setting huge timeouts. Prefer resumable continuation.

5. Test with targets 25, 100, 300, and dry-run/limited 1,000.
   - Confirm no duplicates after rerunning the same import.
   - Confirm partial progress can continue after timeout or reload.
   - Confirm imported counts line up with table-derived visibility.

## 4. Import / Process / Match / Classify Completion Analysis

### Current implementation

Manual import:

- `email-triage.inbox.js`
  - `handleImportApprovedInbox` calls `api.importApprovedInboxPreview`.
  - It refreshes inbox preview/admin view/dashboard afterward.
  - It does not call process or classify.
- `supabase/functions/microsoft-email-sync/index.ts`
  - `sync_import_approved` imports approved preview messages.
  - It returns `processing_enqueued: 0`, `classified_count: 0`, and `drafts_created: 0`.

Live refresh:

- `run_live_refresh` performs:

```text
preview/import likely eBay messages
process imported emails
classify imported emails
```

- But it is capped:
  - import up to 100
  - process batch max 25
  - classify batch max 10

Processing:

- `processImportedEmails` loads approved imported message IDs from recent `sync_import_approved` events.
- It enqueues `normalize` and `match_order` jobs.
- It claims and processes up to a bounded number of jobs.
- A message usually needs both normalize and match_order terminal before classification.

Classification:

- `classifyImportedEmails` uses approved imported message IDs, then selects candidates whose normalize and match jobs are terminal.
- It classifies a bounded number of messages.
- It does not create drafts by default.

Visibility:

- Table-derived pipeline visibility exists and scans imported active messages up to 2,000.
- This is good for diagnostics but is not yet the main driver for completing the mailbox pipeline.

### Beta-critical semantic problem

The current normal import path says "import" but means "persist only."

For beta, operator-facing import should mean:

```text
Import selected/likely/mailbox messages
Process text and metadata
Run deterministic eBay matching
Classify eligible messages
Show usable messages in mailbox
Surface failures/skips clearly
```

Developer/admin "Import Only" can still exist, but it should not be the main operator path.

### Recommended beta semantics

Rename and redesign normal actions around mailbox outcomes:

1. `Import Selected + Prepare`
   - For selected preview rows.
   - Imports, processes, matches, classifies.
   - Returns mailbox-ready count and failure count.

2. `Import Likely + Prepare`
   - For likely eBay rows in a preview page.
   - Imports, processes, matches, classifies.

3. `Import Mailbox`
   - For paged mailbox backfill toward 100/300/1,000.
   - Imports in batches.
   - Prepares each batch or continues preparation after import.

4. Admin-only `Import Only`
   - Kept as a secondary/developer action for troubleshooting.
   - Clearly labeled "Import Only - no processing/classification."

### Fastest safe completion design

Add a resumable preparation loop that can be called repeatedly:

```text
prepare mailbox batch
  find imported active messages needing normalize or match_order
  enqueue missing jobs
  claim/process jobs within time budget
  find eligible processed messages needing classification
  classify within time and rate budget
  return remaining counts and continuation hints
```

Important: do not require the candidate pool to come only from recent import events. For beta, the preparation loop must be able to find active imported mailbox messages that need work directly from tables.

Recommended candidate sources, in priority order:

1. Explicit `messageIds` from the current import page.
2. Active imported messages with missing terminal normalize/match jobs.
3. Active imported messages with terminal processing but no current valid classification.
4. Active imported messages whose classification or draft is stale after rematch.

### Executable implementation steps for 5C

1. Add a backend preparation mode or helper.
   - File: `supabase/functions/microsoft-email-sync/index.ts`
   - Candidate modes:
     - `prepare_imported`
     - `prepare_mailbox`
     - `complete_imported_pipeline`
   - Keep the work bounded by `timeBudgetMs`, `processBatchSize`, and `classificationBatchSize`.

2. Change candidate discovery to table-backed scanning.
   - Existing useful function: table-derived visibility around `loadImportedPipelineVisibility`.
   - Add candidate queries that find:
     - active imported messages missing normalize terminal status
     - active imported messages missing match_order terminal status
     - active imported processed messages with no current valid classification
   - Preserve event-derived paths for historical diagnostics, but do not make event history the only way to complete a mailbox.

3. Return actionable completion status.
   - Response should include:
     - imported total
     - processed total
     - matched total
     - classified total
     - failed processing count
     - failed classification count
     - remaining to process
     - remaining to classify
     - whether another continuation call is needed

4. Update operator import actions to call preparation automatically.
   - File: `email-triage.inbox.js`
   - File: `email-triage.api.js`
   - Normal operator flow should no longer stop after persistence.

5. Update UI copy.
   - File: `email-triage.html`
   - Remove or de-emphasize "Import Likely Only" from the operator path.
   - Use wording like "Import + Prepare Mailbox."
   - Keep import-only warning only where the import-only admin action remains.

6. Add continuation UI.
   - If not all imported emails are classified within the current invocation, show:

```text
Preparing mailbox: 187 classified, 41 still processing, 12 failed.
[Continue Preparing]
```

7. Test completion semantics.
   - Import 1 email, verify it becomes classified or visibly failed.
   - Import 25, verify all eligible emails become classified.
   - Import 100, verify continuation completes.
   - Import 300 or 1,000 in paged mode, verify no silent partial state.

## 5. Mailbox Pagination / Load More / Category Navigation Plan

### Current implementation

Backend:

- `supabase/functions/microsoft-email-classify/index.ts`
  - `MAX_LIMIT = 50`.
  - `adminClassificationView` returns current valid AI classifications.
  - It supports exact category totals by scanning up to 1,000 current valid rows.
  - It does not expose backend pagination, cursor navigation, or category-filtered fetching.

Frontend:

- `email-triage.state.js`
  - Contains a pagination-shaped state object with `limit: 50`, `cursor`, and `hasMore`.
  - This is not fully wired to backend pagination.
- `email-triage.js`
  - Category sidebar can display exact totals when backend provides them.
  - Classification list filters only the currently loaded rows.
  - Category click selects from loaded rows only.
  - If a category total exists outside the loaded slice, clicking can still show no row or fail to select a row.
  - Status text says the result is limited by admin view cap.

### Beta requirement

If a category says 25 emails, the operator must be able to open all 25.

Loaded rows must not be confused with mailbox totals.

### Recommended fastest path

Add backend-backed offset pagination first. Cursor/keyset pagination can come later if performance demands it.

For beta, offset pagination is acceptable if:

- page sizes are small, such as 50.
- total classified rows are near 1,000.
- indexes are adequate.
- category/filter/sort parameters are sent to the backend.

Recommended backend inputs for `admin_view`:

```json
{
  "mode": "admin_view",
  "classificationLimit": 50,
  "classificationOffset": 0,
  "category": "needs_reply",
  "search": "buyer@example.com",
  "sort": "received_desc"
}
```

Recommended backend outputs:

```json
{
  "classifications": [],
  "classification_counts": {
    "total_current_valid": 342,
    "filtered_total": 25,
    "loaded": 50,
    "offset": 0,
    "limit": 50,
    "has_more": true,
    "category_totals": {}
  }
}
```

### Executable implementation steps for 5D

1. Extend admin view input parsing.
   - File: `supabase/functions/microsoft-email-classify/index.ts`
   - Add `classificationOffset`, `category`, `search`, and `sort`.
   - Keep limit capped initially at 50 or 100.

2. Apply filters in backend queries.
   - Category filter should apply to classification category/status fields.
   - Search should initially cover sender email/name, subject, body preview, order ID, item ID, and buyer username if available.
   - Sort should default to received date descending.

3. Return filtered totals and has-more status.
   - Use count queries or exact scans bounded by reasonable limits.
   - Avoid telling the UI a category has rows without offering a way to fetch them.

4. Update API client.
   - File: `email-triage.api.js`
   - Send page/filter/category parameters.
   - Preserve current exact totals for sidebar when no filter is active.

5. Update UI state and list rendering.
   - File: `email-triage.state.js`
   - File: `email-triage.js`
   - Category click should fetch category page 1 from backend.
   - Add `Load More` at the bottom of the list.
   - Do not mutate selected classification to null just because the selected row is outside the loaded page; instead show "not loaded in current view" or fetch it by ID.

6. Update sidebar count labels.
   - Show totals as mailbox totals, not loaded-row counts.
   - If totals are approximate or capped, label them clearly.

7. Test category navigation.
   - Create or use a category with more than 50 rows.
   - Verify the category count matches loaded pages across load-more.
   - Verify clicking a category with rows outside the first page still shows rows.
   - Verify filters/search do not lose access to rows outside the first loaded slice.

## 6. Rematch UI / Backend Semantics Audit And Redesign Recommendation

### Current implementation

Frontend:

- `email-triage.html`
  - `Rematch Existing Emails` is placed in the same panel as preview/import/live refresh.
- `email-triage.inbox.js`
  - `handleRematchExistingEmails` uses `previewControlsFromEls(els)`.
  - This ties rematch to the same limit/days/bucket controls used by preview/import.
- `email-triage.api.js`
  - `rematchExistingEmails` sends `mode: rematch_existing`, `limit`, `daysBack`, `bucketMode`, and `jobTypes: ["match_order"]`.

Backend:

- `supabase/functions/microsoft-email-process/index.ts`
  - `MAX_LIMIT = 100`.
  - `rematchExistingMessages` selects active `email_messages` ordered by latest received date, limited by input limit.
  - Optional `messageId` can target a single email.
  - It calls the shared deterministic matcher.
  - It records `rematch_existing` operational events.
  - It does not reclassify messages or regenerate drafts.

### Actual behavior

The button label sounds broad:

```text
Rematch Existing Emails
```

But the implementation means:

```text
Rematch the latest N active email_messages, where N comes from the nearby preview/import limit selector and is capped at 100.
```

This is confusing and beta-critical because rematch can change deterministic context, which can make classifications/drafts stale. Operators need to know what scope they are changing.

### Recommended beta design

Create a dedicated rematch panel or advanced action with explicit scope:

```text
Rematch
[Current message]
[Current loaded page]
[Current category/filter]
[Latest 25]
[Latest 100]
[All imported mailbox emails] - chunked
```

For beta, recommended initial scopes:

1. Current selected message.
2. Current loaded page.
3. Latest 25.
4. Latest 100.
5. All imported emails, chunked with continuation, only if backend completion is safe.

The UI must say:

```text
Rematch updates deterministic eBay links only. It does not reclassify, regenerate drafts, or send replies.
```

After rematch changes a link, the UI should:

- mark affected classifications/drafts stale using existing staleness logic.
- offer "Reclassify changed messages."
- avoid silently changing reply context without surfacing it.

### Executable implementation steps for 5E

1. Decouple rematch from preview/import controls.
   - File: `email-triage.html`
   - File: `email-triage.inbox.js`
   - File: `email-triage.api.js`
   - Add dedicated rematch scope/limit controls.

2. Extend backend rematch inputs.
   - File: `supabase/functions/microsoft-email-process/index.ts`
   - Accept:
     - `messageIds`
     - `scope: selected | loaded_page | latest | filter | all_imported`
     - `limit`
     - optional `cursor` for all-imported continuation

3. Keep bounded execution.
   - For all-imported rematch, process chunks of 50 or 100 and return continuation.
   - Do not try to rematch 1,000 synchronously unless duration is proven safe.

4. Return link-change detail.
   - Include changed order link counts, changed item link counts, unchanged counts, failures, and continuation.

5. Trigger reloads and stale warnings.
   - Reload admin view and selected details after rematch.
   - Show stale classification/draft warnings where input hashes changed.

6. Test rematch scopes.
   - Current message changes only one message.
   - Latest 25 changes at most 25.
   - Latest 100 changes at most 100.
   - All-imported continuation eventually scans all active imported messages.

## 7. Full Email / Thread Rendering Plan

### Current implementation

Frontend:

- `email-triage.js`
  - `renderEmailBodySection` renders a single `<pre>` block from `detail.normalized_text`.
  - The view is raw/flattened and hard to read for eBay/Outlook conversation history.
- `email-triage.css`
  - `.classification-email-body` is a mono pre block with a fixed max height.

Backend:

- `supabase/functions/microsoft-email-classify/index.ts`
  - `adminMessageDetail` fetches:
    - message subject/sender/from/body preview/date
    - classification
    - matched orders/items
    - body text and normalized text
  - It does not currently return:
    - body HTML
    - recipients
    - conversation ID
    - conversation index
    - internet message ID
    - reply-to emails
    - same-conversation sibling messages

Stored data already available:

- `email_messages`
  - `internet_message_id`
  - `conversation_id`
  - `conversation_index`
  - sender/from fields
  - reply-to emails
  - sent/received dates
  - body preview
  - raw Graph metadata
  - web link
- `email_message_bodies`
  - `body_text`
  - `body_html`
  - `normalized_text`
- `email_message_recipients`
  - recipient type, email, and name

### Beta goal

Make full email reading feel like a mailbox conversation, not a database text blob.

The first beta does not need pixel-perfect Outlook/eBay rendering. It does need:

- readable message blocks.
- buyer vs operator vs platform/system labeling where possible.
- preserved line breaks.
- visible timestamps and sender names.
- quoted history separated from latest content where possible.
- access to Outlook original via `web_link` if available.

### Recommended beta approach

Use a hybrid approach:

1. Conversation reconstruction from stored messages.
   - Query same `conversation_id` messages in `email_messages`.
   - Sort by received/sent date or `conversation_index`.
   - Render each stored email as a conversation block.

2. Structured text fallback.
   - For each message, use body text/normalized text.
   - Split likely quoted history using common separators:
     - `From:`
     - `Sent:`
     - `To:`
     - `Subject:`
     - `On ... wrote:`
     - eBay platform separator patterns
   - Preserve line breaks.
   - Label parsed blocks as current message, quoted previous message, buyer message, previous operator message, or platform message when confidence is high.

3. Sanitized HTML later or carefully.
   - Stored `body_html` can improve fidelity.
   - Do not render raw email HTML unsanitized.
   - If HTML is used in beta, sanitize server-side or add a vetted frontend sanitizer.
   - Until sanitizer is in place, structured text is safer.

### Executable implementation steps for 5F

1. Extend `adminMessageDetail`.
   - File: `supabase/functions/microsoft-email-classify/index.ts`
   - Include:
     - `conversation_id`
     - `conversation_index`
     - `internet_message_id`
     - `reply_to_emails`
     - `web_link`
     - recipients
     - body text
     - optionally body HTML only if sanitized or withheld from direct render

2. Add conversation sibling query.
   - Query active `email_messages` with same `conversation_id`.
   - Include bodies and recipients.
   - Limit initially to 25 or 50 messages in one conversation.

3. Add a thread normalization helper.
   - Server-side is preferred so tests can cover parsing.
   - Return blocks like:

```json
{
  "thread_blocks": [
    {
      "kind": "message",
      "role": "buyer",
      "sender": "Buyer Name",
      "received_at": "...",
      "text": "...",
      "confidence": "stored_message"
    },
    {
      "kind": "quoted_history",
      "role": "operator",
      "label": "Your previous message",
      "text": "...",
      "confidence": "heuristic"
    }
  ]
}
```

4. Update UI renderer.
   - File: `email-triage.js`
   - File: `email-triage.css`
   - Replace the single raw `<pre>` with message cards/blocks inside the detail panel.
   - Use compact mailbox styling, not debugging labels.

5. Add fallback.
   - If parsing fails, show a readable plain-text body with preserved line breaks and a clear "Open in Outlook" link when available.

6. Test with real eBay-style messages.
   - Latest buyer message with quoted previous operator reply.
   - Platform notification email.
   - Conversation with multiple imported messages sharing `conversation_id`.
   - Message with no body text but body HTML present.

## 8. Draft / Reply Workflow Plan

### Current implementation

Backend:

- `supabase/functions/microsoft-email-classify/index.ts`
  - Supports `generate_response`, `regenerate_response`, `admin_draft_view`, `save_draft_review`, `approve_draft`, and `reject_draft`.
  - Generated drafts are validated and can fall back to a conservative safe draft.
  - Human-edited drafts are persisted as new current human drafts.
  - Approval/rejection updates review status.
  - All draft responses declare `outbound_send_enabled: false`.

Frontend:

- `email-triage.js`
  - Draft panel supports generate, regenerate, refresh, edit subject/body, save edits, approve, and reject.
  - UI clearly says approved drafts do not send.
  - Stale draft warnings are rendered.
- `email-triage.drafts.js`
  - User-facing messages reinforce that save/approve/reject do not send.

### What works for beta

- Operator can generate a draft.
- Operator can edit the draft.
- Operator can approve or reject the draft.
- Drafts are review-only and do not mutate Outlook.
- Staleness warnings exist when deterministic context changes.

### Beta gaps

1. "Approve" is not the same as "ready to send" in operator language.
   - The UI should make approved drafts feel like a reply workflow state, not an internal review state.

2. Human-edited drafts may need re-validation.
   - Current save path enforces body length/body presence.
   - It appears to preserve validation/safety metadata from the source draft.
   - A human edit can introduce claims or promises that were not validated by the original AI draft.

3. Verified facts/context need stronger display.
   - Operators should see the order, item, buyer, stale warnings, and missing-context warnings close to the draft.

4. No "send readiness" state exists yet.
   - Sending is intentionally absent, but beta UI should prepare the mental model:

```text
Draft -> Reviewed -> Ready to Send -> Sent
```

### Executable implementation steps for 5G

1. Rename review states in UI language.
   - File: `email-triage.js`
   - File: `email-triage.drafts.js`
   - Use operator terms:
     - "Draft"
     - "Needs review"
     - "Ready to send"
     - "Rejected"
   - Keep backend enum names if migration is not needed.

2. Add context/fact panel near draft.
   - Show matched order/item, buyer, category, stale status, and confidence.
   - Reuse existing message detail data.

3. Re-validate human-edited draft before approval.
   - File: `supabase/functions/microsoft-email-classify/index.ts`
   - At minimum, run the same deterministic safety checks used for generated drafts against edited subject/body.
   - If full AI validation is too slow, add a cheap beta guard:
     - body required
     - max length
     - no unsupported send claims
     - stale context warning blocks approval unless explicitly confirmed

4. Prepare send-disabled UI.
   - Add a disabled or gated "Send through Outlook" control only after 5H/5I design is accepted.
   - Before 5I, the button should not exist or should be disabled behind a clear "send not enabled" state.

5. Test draft workflow.
   - Generate, edit, save, approve, reject.
   - Rematch a message and confirm stale draft warning.
   - Try approval with stale context and verify the UI blocks or warns as designed.

## 9. Safe Outlook Sending Plan

### Current implementation

There is no send path. This is good.

Observed current Graph scopes are read-only:

```text
offline_access Mail.Read User.Read
```

No Email Triage function currently uses `Mail.Send`, Graph `sendMail`, or Graph `createReply`/`reply` behavior for outbound replies.

### Sending should be a separate phase

Recommended split:

```text
5H - Safe Outlook Reply/Send Design
5I - Safe Outlook Reply/Send Implementation
```

Do not combine safe send with import/classification scale work. Sending introduces new OAuth scopes, irreversible side effects, audit requirements, and duplicate-send risk.

### Required safe send design

1. Graph permissions/scopes.
   - Add `Mail.Send` only when ready.
   - Determine whether delegated `Mail.Send` is sufficient.
   - Existing users may need to reconnect Outlook to grant expanded scopes.
   - UI must show whether the mailbox is send-enabled.

2. New Edge Function boundary.
   - Candidate function: `supabase/functions/microsoft-email-send`.
   - The classify function should not directly send.
   - Draft generation and sending must remain separate.

3. Explicit human confirmation.
   - Send requires:
     - selected message
     - current approved/ready draft
     - latest draft body visible
     - explicit confirm action
     - no stale blocker unless operator confirms with elevated warning

4. Audit table.
   - Add table such as `email_outbound_sends`.
   - Fields likely needed:
     - `id`
     - `email_message_id`
     - `response_draft_id`
     - `provider`
     - `provider_message_id`
     - `provider_conversation_id`
     - `idempotency_key`
     - `send_status`
     - `requested_by`
     - `requested_at`
     - `sent_at`
     - `provider_response`
     - `error_code`
     - `error_message`
     - `created_at`
     - `updated_at`

5. Idempotency and duplicate-send prevention.
   - Generate a send idempotency key from draft ID + target message ID + approved revision.
   - Block a second send for the same ready draft unless explicitly creating a new draft revision.
   - Store provider response metadata.

6. Reply-to-thread behavior.
   - Prefer Graph reply/createReply flow when replying to an existing Outlook message.
   - Preserve original conversation/thread when possible.
   - If the original message is missing/deleted, fail safely instead of sending a new disconnected email without confirmation.

7. Failure handling.
   - Show pending, sent, failed, and retryable states.
   - Retry only after human action.
   - Do not auto-send after transient failure.

8. Sent state in UI.
   - Once sent, show sent timestamp, recipient, subject, and provider message metadata.
   - Lock or archive the draft revision used for sending.

9. No autonomous sending.
   - AI generation cannot call send.
   - Approval cannot automatically send.
   - Send must be a separate explicit operator click.

### Executable implementation steps for 5H

1. Create a send design document before adding scopes.
   - Include permission model, audit schema, function boundary, idempotency, UI states, and test plan.

2. Confirm Microsoft Graph endpoint choice.
   - Options:
     - `POST /me/messages/{id}/reply`
     - `POST /me/messages/{id}/createReply` then update/send draft
     - `POST /me/sendMail`
   - For thread fidelity, reply/createReply is likely preferred.

3. Confirm reconnect/admin consent flow.
   - Check auth start/callback functions.
   - Determine how expanded scopes are detected and displayed.

### Executable implementation steps for 5I

1. Add migration for send audit table and statuses.
2. Add `Mail.Send` scope only when implementation is ready.
3. Add `microsoft-email-send` Edge Function.
4. Add UI send readiness and explicit confirmation.
5. Add idempotency and duplicate-send tests.
6. Test in a controlled mailbox only.

## 10. Full UI Beta Usability Audit

### Inbox preview/import panel

Current issues:

- It is framed around backend operations, not mailbox outcomes.
- `Import Likely Only` sounds useful but intentionally stops before processing/classification.
- Preview/import/rematch/live refresh share nearby controls, causing scope confusion.
- Limit selector does not communicate mailbox scale or backend caps.
- Live refresh being gated by live sync enablement is not intuitive for an operator.

Beta recommendation:

- Primary operator action:

```text
Import Mailbox
```

- Secondary actions:

```text
Preview recent Outlook emails
Import selected + prepare
Continue preparing mailbox
```

- Advanced/admin actions:

```text
Import only
Rematch
Replay processing
Diagnostics
```

### Rematch controls

Current issues:

- Button is next to import controls.
- Uses preview limit.
- Label implies all existing emails but only rematches latest N.

Beta recommendation:

- Separate panel or advanced menu.
- Explicit scope and count.
- Clear note that rematch updates deterministic links only.

### Category sidebar

Current issues:

- Exact totals can exceed loaded rows.
- Click behavior only searches loaded rows.
- Operator can see a count but not open all rows.

Beta recommendation:

- Sidebar category click must trigger backend category fetch.
- Counts should represent mailbox totals.
- UI should show loaded/page status separately.

### Classification list

Current issues:

- Loaded result cap is exposed as admin view cap.
- No mailbox-style load more.
- Selection can be cleared when filters hide loaded rows.

Beta recommendation:

- Replace admin cap copy with mailbox pagination copy:

```text
Showing 50 of 342. Load more.
```

- Add backend-backed `Load More`.
- Preserve selected message or fetch selected detail by ID.

### Detail panel

Current issues:

- Detail is closer to a classification/debug view than a reply workspace.
- Full email is raw text.
- Matched context, stale state, and draft readiness are present but can be better organized around operator decisions.

Beta recommendation:

- Layout:

```text
Message header
Conversation thread
Matched eBay context
AI classification and reason
Reply draft workspace
Operational details collapsed
```

### Full email viewer

Current issues:

- Raw flattened body.
- Not enough message/thread structure.

Beta recommendation:

- Conversation blocks with sender, date, and role labels.
- Plain text fallback.
- Safe Outlook link.

### Draft panel

Current issues:

- Functional but still review-system oriented.
- Approval does not mean send-ready clearly enough.

Beta recommendation:

- Use "Ready to send" language.
- Show facts/context next to draft.
- Block or warn on stale context.

### Operational dashboard

Current issues:

- Useful for engineering, but too pipeline-focused for normal operators.

Beta recommendation:

- Keep diagnostics available.
- Default operator surface should show:
  - imported
  - ready
  - needs reply
  - failed
  - preparing
  - sent/not sent

### Filters/search/sort

Current issues:

- Filtering appears frontend-loaded-row based.
- Search/filter can hide rows outside the first loaded slice.

Beta recommendation:

- Move core filters/search/sort to backend.
- Keep client-side filtering only as a quick within-page helper if needed.

### Loading/disabled/error/empty states

Current issues:

- Disabled cursor has been fixed.
- Pipeline progress and continuation states are still not operator-friendly.

Beta recommendation:

- Show progress by mailbox outcome:
  - importing
  - preparing
  - classified
  - failed
  - remaining
- Empty states should say what action to take next.

## 11. Backend Beta Reliability Audit

### Edge Function duration

Risk:

- 1,000 full-message Graph fetches plus processing/classification cannot fit safely in one request.

Recommendation:

- Use bounded page imports.
- Return continuation.
- Drain processing/classification in bounded loops.

### Graph pagination

Risk:

- Preview path does not follow `@odata.nextLink`.
- Durable delta path does, but is not yet the operator mailbox bootstrap.

Recommendation:

- Use durable pagination for mailbox bootstrap.
- Keep preview as a small sample.

### Idempotency

Strength:

- Existing upsert/import model appears designed to avoid duplicate rows.

Risk:

- Large repeated imports must be tested for duplicate operational events and duplicate body/recipient rows.

Recommendation:

- Add explicit already-imported count in progress responses.

### Queue draining

Risk:

- Current process/classify caps leave partial work.
- Candidate discovery relies too much on recent import events.

Recommendation:

- Table-backed candidate discovery for all active imported mailbox messages.
- Continuation UI until `remaining_to_process` and `remaining_to_classify` reach zero or only failures remain.

### Classification caps and OpenAI risk

Risk:

- Classifying 1,000 emails can hit rate/cost/time constraints.

Recommendation:

- Classify in small chunks.
- Surface cost/rate failures.
- Allow resume.
- Avoid generating drafts automatically for every classified email.

### Supabase query/index performance

Risk:

- Pagination/filter/search across 1,000+ imported/classified messages may need indexes.

Recommendation:

- First implement with existing indexes and measure.
- Add targeted indexes only if queries are slow.
- Likely useful indexes if missing:
  - current valid classifications by category and created/received date
  - `email_messages(conversation_id)`
  - active imported received date
  - processing jobs by message/job type/status

### RLS/security/service role

Risk:

- Edge functions use service role for backend operations.
- Sending will increase blast radius if added later.

Recommendation:

- Keep send in a separate function and audit table.
- Never let AI generation call send.

### Logging safety

Risk:

- Large email bodies and draft content should not be logged in operational events.

Recommendation:

- Progress events should store counts and IDs, not full email bodies or generated replies.

### Partial import recovery

Risk:

- Current manual import can leave messages in partial state forever unless another process/classify action catches them.

Recommendation:

- Preparation loop must be resumable and table-backed.

### Migration drift

Risk:

- The team has known migration drift/reconciliation from parallel branches.

Recommendation:

- Avoid migrations in 5B-5G unless truly necessary.
- For 5I sending, a migration is appropriate and should be isolated.

## 12. Recommended Shortest Implementation Sequence

### 5A - Beta Readiness Audit

Status: This document.

Goal:

- Convert stabilization roadmap into beta product roadmap.

Migration:

- No.

Edge deploy:

- No.

Frontend changes:

- No.

### 5B - Mailbox Scale Foundation: Import 1,000 + Durable Batch Progress

Goal:

- Add a safe operator path to import toward 100, 300, or 1,000 Outlook emails using paged continuation.

Executable steps:

1. Expose durable mailbox bootstrap/backfill action.
2. Return progress and continuation.
3. Add frontend import target selector and progress UI.
4. Keep preview small.
5. Test rerun/idempotency/partial continuation.

Migration:

- Prefer no.
- Possible only if existing sync state/run tables cannot represent operator-visible progress.

Edge deploy:

- Yes, `microsoft-email-sync`.

Frontend changes:

- Yes.

### 5C - Import/Process/Match/Classify Completion

Goal:

- Make imported emails become mailbox-usable without manual pipeline knowledge.

Executable steps:

1. Add bounded `prepare_mailbox` or equivalent.
2. Switch candidate discovery to table-backed imported active messages.
3. Automatically call preparation after import pages.
4. Add continuation UI.
5. Surface failures/skips.

Migration:

- Prefer no.
- Possible if a new parent operational event type is required.

Edge deploy:

- Yes, `microsoft-email-sync`.
- Possibly `microsoft-email-classify` if classification input/status response changes.

Frontend changes:

- Yes.

### 5D - Mailbox Pagination + Category Navigation

Goal:

- Make category totals navigable and mailbox lists complete.

Executable steps:

1. Add backend pagination/filter/category/sort params to admin view.
2. Add filtered totals and `has_more`.
3. Add frontend category fetch and load-more.
4. Stop treating loaded slice as total mailbox.

Migration:

- Probably no.
- Add indexes later only if measured slow.

Edge deploy:

- Yes, `microsoft-email-classify`.

Frontend changes:

- Yes.

### 5E - Rematch UX + Scope Controls

Goal:

- Make rematch scope explicit and separate from import preview.

Executable steps:

1. Add dedicated rematch controls.
2. Add backend scope inputs and optional chunk continuation.
3. Return changed/unchanged/failure details.
4. Offer reclassify changed messages after rematch.

Migration:

- Prefer no.

Edge deploy:

- Yes, `microsoft-email-process`.

Frontend changes:

- Yes.

### 5F - Full Email Thread Rendering

Goal:

- Replace raw flattened text with readable mailbox conversation blocks.

Executable steps:

1. Extend message detail payload with conversation/body/recipient fields.
2. Query same-conversation messages.
3. Parse text into message/quoted blocks.
4. Render conversation blocks in UI.
5. Add safe fallback and Outlook link.

Migration:

- No expected migration.

Edge deploy:

- Yes, `microsoft-email-classify`.

Frontend changes:

- Yes.

### 5G - Draft Review UX Hardening

Goal:

- Make draft review feel like operator reply preparation.

Executable steps:

1. Rename UI states around "ready to send."
2. Show verified context/facts next to draft.
3. Re-validate human-edited drafts before approval.
4. Block or warn on stale context.

Migration:

- Prefer no.

Edge deploy:

- Possibly yes, `microsoft-email-classify`.

Frontend changes:

- Yes.

### 5H - Safe Outlook Reply/Send Design

Goal:

- Produce explicit send design before adding irreversible side effects.

Executable steps:

1. Design Graph scope/reconnect flow.
2. Design send audit table.
3. Design idempotency and duplicate-send prevention.
4. Choose Graph reply endpoint.
5. Define UI confirmation and sent state.

Migration:

- No implementation migration in design step.

Edge deploy:

- No.

Frontend changes:

- No implementation required.

### 5I - Safe Outlook Reply/Send Implementation

Goal:

- Allow explicit human-approved Outlook replies from the app.

Executable steps:

1. Add send audit migration.
2. Add `Mail.Send` scope and reconnect handling.
3. Add send Edge Function.
4. Add UI send confirmation.
5. Add sent/failed status tracking.
6. Test in controlled mailbox.

Migration:

- Yes.

Edge deploy:

- Yes, new send function and auth changes.

Frontend changes:

- Yes.

### 5J - Beta QA / Operator Trial Checklist

Goal:

- Validate end-to-end operator mailbox behavior.

Executable steps:

1. Import 25, 100, 300, and target 1,000.
2. Confirm all eligible imported emails are processed/matched/classified or visibly failed.
3. Confirm category totals are navigable.
4. Confirm rematch scope is explicit.
5. Confirm full email view is readable.
6. Confirm draft review workflow is usable.
7. If 5I is enabled, confirm send idempotency and audit trail.

Migration:

- No.

Edge deploy:

- No unless fixes are found.

Frontend changes:

- No unless fixes are found.

## 13. Files Likely Touched Per Step

### 5B

- `supabase/functions/microsoft-email-sync/index.ts`
- `email-triage.html`
- `email-triage.inbox.js`
- `email-triage.api.js`
- `email-triage.state.js`
- `email-triage.css`

### 5C

- `supabase/functions/microsoft-email-sync/index.ts`
- `supabase/functions/microsoft-email-classify/index.ts`
- `email-triage.html`
- `email-triage.inbox.js`
- `email-triage.api.js`
- `email-triage.js`
- `email-triage.css`

### 5D

- `supabase/functions/microsoft-email-classify/index.ts`
- `email-triage.api.js`
- `email-triage.state.js`
- `email-triage.js`
- `email-triage.css`

### 5E

- `supabase/functions/microsoft-email-process/index.ts`
- `email-triage.html`
- `email-triage.inbox.js`
- `email-triage.api.js`
- `email-triage.js`
- `email-triage.css`

### 5F

- `supabase/functions/microsoft-email-classify/index.ts`
- `email-triage.js`
- `email-triage.api.js`
- `email-triage.css`

### 5G

- `supabase/functions/microsoft-email-classify/index.ts`
- `email-triage.js`
- `email-triage.drafts.js`
- `email-triage.css`

### 5H

- Design document only.
- Likely future references:
  - `supabase/functions/microsoft-auth-start/index.ts`
  - `supabase/functions/microsoft-auth-callback/index.ts`
  - `supabase/config.toml`
  - future send migration

### 5I

- New migration under `supabase/migrations/`
- New function `supabase/functions/microsoft-email-send/index.ts`
- `supabase/functions/microsoft-auth-start/index.ts`
- `supabase/functions/microsoft-auth-callback/index.ts`
- `supabase/config.toml`
- `email-triage.api.js`
- `email-triage.js`
- `email-triage.drafts.js`
- `email-triage.css`

## 14. Migration Expectations Per Step

### No migration expected

- 5A audit
- 5D pagination, unless performance requires indexes
- 5F thread rendering
- 5J QA

### Migration should be avoided if possible

- 5B mailbox import scale
  - Reuse existing durable sync state/run tables if possible.
- 5C completion semantics
  - Reuse existing job tables and operational event types if possible.
- 5E rematch scope controls
  - Reuse existing `rematch_existing` event type.
- 5G draft UX hardening
  - Reuse existing draft review statuses if possible.

### Migration likely required

- 5I safe sending implementation
  - New send audit table.
  - Possibly new status enum/check constraints.
  - Possibly indexes for sent-state lookup.

### Migration caution

The project has known migration drift risk from parallel branches and Supabase repair/reconciliation flows. Beta acceleration should minimize migrations until the send implementation or measured performance requires them.

## 15. Edge Deploy Expectations Per Step

### No deploy

- 5A
- 5H if it remains design-only
- 5J unless fixes are made

### Deploy required

- 5B
  - `microsoft-email-sync`
- 5C
  - `microsoft-email-sync`
  - possibly `microsoft-email-classify`
- 5D
  - `microsoft-email-classify`
- 5E
  - `microsoft-email-process`
- 5F
  - `microsoft-email-classify`
- 5G
  - possibly `microsoft-email-classify`
- 5I
  - new `microsoft-email-send`
  - auth functions if scopes change
  - possibly config changes

## 16. Testing Checklist Per Step

### 5B tests

- Preview 25 recent Outlook emails.
- Import target 100 with continuation.
- Import target 300 with continuation.
- Import target 1,000 in a controlled mailbox or staged mailbox.
- Interrupt/reload mid-import, then continue.
- Rerun import and verify duplicate rows are not created.
- Verify progress counts match stored rows.
- Verify no request depends on a single 1,000-message synchronous operation.

### 5C tests

- Import 1 selected message and verify it becomes classified or visibly failed.
- Import 25 likely messages and verify all eligible messages complete.
- Import 100 and verify continuation drains remaining process/classify work.
- Verify process and classify candidate discovery catches old imported messages not present in recent import events.
- Verify failed/skipped messages appear with actionable reason.
- Verify no drafts are generated automatically unless explicitly requested.

### 5D tests

- Load first 50 classifications.
- Load next 50.
- Click a category with more rows than the first page.
- Verify category count equals navigable total.
- Apply search/filter and verify backend fetch returns matching rows outside first page.
- Verify selected message detail still opens after pagination/filter changes.

### 5E tests

- Rematch current selected message.
- Rematch current loaded page.
- Rematch latest 25.
- Rematch latest 100.
- If all-imported scope exists, rematch in chunks with continuation.
- Verify changed matches mark classifications/drafts stale.
- Verify rematch does not reclassify or send.

### 5F tests

- View a simple single-message email.
- View an eBay thread with quoted previous messages.
- View a conversation with multiple imported messages sharing `conversation_id`.
- View message with HTML body and weak text fallback.
- Verify no unsafe raw HTML is rendered.
- Verify "Open in Outlook" link appears when `web_link` exists.

### 5G tests

- Generate draft.
- Edit and save draft.
- Approve draft.
- Reject draft.
- Rematch related message and confirm stale warning.
- Try approving stale or unsafe edited draft and verify warning/block.

### 5H tests

- Design review only.
- Confirm no scopes changed.
- Confirm no send code deployed.

### 5I tests

- Reconnect Outlook with Mail.Send in a controlled account.
- Send one reply from approved draft.
- Verify sent audit row.
- Retry same send and verify duplicate send is blocked.
- Simulate Graph failure and verify no automatic retry send.
- Verify sent state appears in UI.
- Verify AI generation cannot send.

### 5J tests

- Run a full operator trial:

```text
Connect mailbox
Import 1,000 target
Wait/continue until prepared
Open categories
Read threads
Generate/edit/approve drafts
Send only if 5I is enabled
Verify failures are visible
```

## 17. Clear Do Now Vs Defer Recommendations

### Do now before beta

1. 5B mailbox import/backfill toward 1,000.
2. 5C import/process/match/classify completion semantics.
3. 5D backend-backed pagination/load-more/category navigation.
4. 5E rematch scope clarity.
5. 5F readable full email/thread view.
6. 5G draft review UX hardening if replies are part of beta review.

### Do soon after beta starts

1. Better search and sorting.
2. Better mailbox folders/states.
3. Richer conversation parsing and HTML sanitization.
4. Better cost/rate dashboard for classification.
5. Performance indexes if measured necessary.
6. Operator-specific saved views.

### Defer

1. Full migration/event governance hardening unless it directly blocks a step.
2. Broad telemetry refactors.
3. Pixel-perfect Outlook/eBay visual matching.
4. Autonomous or scheduled sending.
5. AI privacy/exposure redesign that was already deferred, unless beta scope expands beyond trusted internal use.
6. Sending implementation until 5H send design is accepted.

## 18. Risks That Could Block Tomorrow-Level Beta Readiness

1. Edge Function duration.
   - Importing, processing, and classifying 1,000 messages cannot be one request.
   - Mitigation: bounded continuation.

2. OpenAI classification throughput and cost.
   - 1,000 classifications may hit rate/cost/time limits.
   - Mitigation: chunk classification and expose progress.

3. Current process/classify caps.
   - Existing 25/10 caps leave partial state.
   - Mitigation: repeat bounded batches until complete.

4. Candidate discovery from recent import events.
   - Older imported rows may be stranded.
   - Mitigation: table-backed candidate discovery.

5. Category navigation correctness.
   - Exact totals without backend category pages will continue to confuse operators.
   - Mitigation: 5D before serious beta use.

6. Raw email rendering.
   - Operators may misread flattened eBay/Outlook threads.
   - Mitigation: 5F readable thread blocks.

7. Rematch side effects.
   - Rematch can change deterministic context and make drafts stale.
   - Mitigation: explicit scope and stale warnings.

8. Send scope and irreversible mutation.
   - Mail.Send requires OAuth changes and duplicate-send prevention.
   - Mitigation: keep send separate in 5H/5I.

9. Migration drift.
   - Parallel branch migrations can slow beta work.
   - Mitigation: avoid migrations until required, isolate send migration.

10. Frontend request timeouts.
    - Current 60-second import/rematch timeout is not enough for large synchronous work.
    - Mitigation: continuation instead of larger synchronous batches.

## Final Recommendation

Proceed next with:

```text
5B - Mailbox Scale Foundation: Import 1,000 + Durable Batch Progress
```

But define the 5B API response so it can immediately feed 5C completion:

```text
import progress
imported message IDs or batch scope
remaining import count
remaining process count
remaining classify count
continuation token/status
failure summary
```

The fastest safe beta path is not to make the existing preview/import limit larger. It is to introduce a resumable mailbox import/preparation workflow that turns Outlook email batches into visible, classified mailbox rows with clear progress and recovery.
