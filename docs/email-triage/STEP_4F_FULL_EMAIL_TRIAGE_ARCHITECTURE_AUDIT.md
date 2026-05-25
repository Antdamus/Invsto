# Step 4F Full Email Triage Architecture Audit

Date: 2026-05-25  
Scope: OG Email Triage only  
Mode: audit-only  
Primary output: `docs/email-triage/STEP_4F_FULL_EMAIL_TRIAGE_ARCHITECTURE_AUDIT.md`

## 1. Executive Summary

Email Triage now has the core shape of a safe operator-assisted system:

- Microsoft OAuth and mailbox connection persistence are server-side.
- Outlook preview/import is bounded, explicit, and uses `Mail.Read` only.
- Full message persistence, body normalization, processing jobs, deterministic eBay matching, AI classification, draft persistence, and dashboard diagnostics exist.
- Draft generation is intentionally non-sending, human-review-only, and has strong guardrails plus fallback draft behavior.
- Edge Functions generally expose self-reported safety flags such as `outlook_mutation_performed: false`, `automatic_responses_sent: 0`, and `outbound_send_enabled: false`.

The system is not yet operationally coherent enough for more feature work without stabilization. The largest risks are not one single missing feature, but mismatches between what operators see and what the backend actually did:

- Manual import writes emails but does not process, match, classify, or draft them.
- Live refresh does import, process, and classify, but classification is capped and state can remain partial.
- Dashboard pipeline gaps are event-derived, so imported messages can be invisible if the operational event is missing or outside the event window.
- The classification category panel is a loaded-row view, not a total/current classification view.
- Rematch results show aggregate counts but not which emails or links changed.
- Rematch and match review can change deterministic context without reclassifying or invalidating drafts.
- Migration history uses repeated drop-and-recreate check constraints for `email_operational_events.event_type`, which is locally cumulative today but fragile under teammate branch interleaving.

Confirmed bugs:

- Disabled button spinner bug: confirmed. Button CSS gives all disabled primary/secondary/danger buttons `cursor: wait`, conflating unavailable with busy.
- Category count showing `All = 50`: confirmed and refined. The frontend asks for 100 classifications, but `microsoft-email-classify` caps `classificationLimit` at 50. The sidebar count is the loaded row count, not a total count, and the backend admin view does not restrict rows to current valid classifications.
- Rematch visibility: confirmed weak. The backend returns `message_ids`, aggregate counts, and failures, but the UI renders only aggregate counts and safety flags.
- Pipeline gaps: confirmed. Several partial states are possible and some are acceptable as intermediate states, but they are not visible enough or automatically resolved.

Recommendation: stabilize first. The first implementation step should be `4F.4C-Hotfix`: fix disabled button state, make classification counts explicit, expose imported/processed/classified totals without implying they are complete, and improve rematch result visibility without changing pipeline behavior.

## 2. Current Architecture Map

Current flow:

```text
Microsoft Outlook / Microsoft Graph
  -> Microsoft OAuth Edge Functions
  -> persisted Microsoft mailbox connection and encrypted refresh-token secret
  -> Email bootstrap / preview / import / sync Edge Functions
  -> email persistence tables
  -> processing jobs for normalization and deterministic matching
  -> local eBay database context lookup
  -> AI classification function
  -> AI draft generation and draft persistence
  -> frontend Email Triage UI
  -> operational dashboard and diagnostics
```

Important paths:

- OAuth starts in browser through `email-triage.api.js`, then `microsoft-auth-start`.
- OAuth callback is public but HMAC-state-protected in `microsoft-auth-callback`.
- Refresh tokens are encrypted in `microsoft_mailbox_connection_secrets`.
- Browser never receives refresh tokens or service role credentials.
- Outlook message previews come from Microsoft Graph metadata only.
- Approved imports fetch full message bodies and persist them in email tables.
- Processing and matching use stored email text and local eBay tables.
- Classification and draft generation call OpenAI from the Edge Function, not from browser JS.
- Drafts are saved internally and are not sent.

Two processing paths currently coexist:

- `microsoft-email-sync` has an embedded `process_imported` path and a simpler deterministic matcher.
- `microsoft-email-process` has the richer standalone matcher and rematch path.

That duplication creates drift. Rematch can find context that the live-refresh process path did not originally find.

## 3. File / Module Inventory

Frontend:

| File | Responsibility | Audit notes |
|---|---|---|
| `email-triage.html` | Email Triage admin shell, Outlook toolbar, inbox preview/import controls, dashboard, classification/draft/context panels | Correctly separates operator controls, but several buttons rely on shared disabled/loading styling. |
| `email-triage.css` | Email Triage styles | Contains confirmed disabled cursor bug: disabled primary/secondary/danger buttons use `cursor: wait`. |
| `email-triage.api.js` | Supabase Edge Function client wrappers and payload normalizers | Frontend requests 100 classifications, but backend caps at 50. Normalizes live refresh, rematch, and dashboard payloads. |
| `email-triage.state.js` | Central local UI state store defaults | Tracks independent inbox loading flags, selection, classification/draft/context caches, and dashboard state. Default classification pagination is not real backend pagination. |
| `email-triage.inbox.js` | Preview/import/live refresh/rematch UI behavior | Imports trigger dashboard/classification reload callbacks. All inbox buttons get `is-loading`/`aria-busy` during any inbox operation. Rematch UI hides changed message details. |
| `email-triage.operations.js` | Operational dashboard init/wiring | Thin wrapper over diagnostics rendering. |
| `email-triage.classifications.js` | Category grouping and labels | Groups are applied to loaded rows only. |
| `email-triage.drafts.js` | Draft helper functions and selectors | Supports draft UI through main renderer. |
| `email-triage.diagnostics.js` | Dashboard renderer | Good safety/gap/queue surface, but source data has event-derived blind spots. |
| `email-triage.render-utils.js` | Formatting, filtering, sorting, badges | Filtering operates on the loaded classification slice. |
| `email-triage.js` | Main controller, admin guard, render orchestration, actions | Mutates selected classification during render, uses loaded classification rows for sidebar counts, refreshes related views after some but not all state-changing actions. |
| `admin-nav.js` | Admin nav item for Email Triage | Adds `email-triage.html` entry. |

Edge Functions:

| Function | Responsibility |
|---|---|
| `microsoft-auth-start` | Admin-authenticated OAuth URL generation with signed state. |
| `microsoft-auth-callback` | Public OAuth callback, state verification, token exchange, connection and encrypted refresh-token persistence. |
| `microsoft-mailbox-status` | Sanitized mailbox connection status. |
| `microsoft-mailbox-disconnect` | Deletes stored refresh-token secret and marks connection disconnected. |
| `microsoft-latest-messages` | Reads latest Outlook message metadata/body preview for POC display. |
| `microsoft-email-bootstrap` | Creates/updates `email_mailboxes`, inbox folder, sync state, and bootstrap run. Does not import messages. |
| `microsoft-email-sync` | Preview, approved import, live refresh, process imported, classify imported, diagnostics, durable delta sync paths. |
| `microsoft-email-process` | Normalize/match jobs and richer deterministic rematch of existing emails. |
| `microsoft-email-classify` | AI classification, admin view, message detail, match context, match review, draft generation/review/diagnostics. |
| `microsoft-email-ops` | Operational queue/status/replay/requeue controls. |

Docs:

- `docs/email-triage/*` contains historical step docs, prior audits, plans, and classifier fixtures.
- This audit supersedes partial architecture notes for Step 4F planning, but does not replace implementation-specific docs.

## 4. Database / Migration Inventory

Core Microsoft mailbox tables:

| Table | Key columns / purpose | Risk notes |
|---|---|---|
| `microsoft_mailbox_connections` | mailbox email, Microsoft user id, connection status, scopes, access-token expiry, health metadata, `live_sync_enabled` added later | Single active connection enforced by unique index. No refresh token stored here. |
| `microsoft_mailbox_connection_secrets` | encrypted refresh-token ciphertext, IV, key version, rotation time | Service-role only. Browser cannot select. |

Email persistence tables:

| Table | Key columns / purpose | Risk notes |
|---|---|---|
| `email_mailboxes` | provider, Microsoft connection id, mailbox email, status, sync flag | Bridge from Microsoft connection to provider-neutral email system. |
| `email_folders` | mailbox folder metadata | Bootstrap creates inbox folder. |
| `email_messages` | provider ids, subject, sender, dates, Graph metadata, `sync_status` | Approved import and durable sync upsert rows. |
| `email_message_recipients` | normalized recipient rows | Imported alongside full messages. |
| `email_message_bodies` | raw text/html, normalized text, hashes, redaction status | Full raw email bodies are stored unredacted by default. |
| `email_attachments` | attachment metadata | Metadata-only foundation. |
| `email_sync_states` | delta link/checkpoint and sync status | Live refresh intentionally does not update checkpoint; durable sync does. |
| `email_sync_runs` | durable sync/bootstrap run accounting | Live refresh is tracked through operational events, not sync runs. |

Processing, classification, matching, drafts:

| Table | Key columns / purpose | Risk notes |
|---|---|---|
| `email_processing_jobs` | message id, job type, status, attempts, input version, metadata | Queue state exists, but live-refresh processing has no first-class `process_imported` operational event. |
| `email_message_links` | deterministic links to eBay order/order line/inventory/sale/customer, confidence, status, metadata | Rematch can update/create links without reclassifying or invalidating drafts. |
| `email_message_classifications` | category, priority, urgency, validation, prompt/input hashes, current/superseded fields, review overrides | Admin view does not filter to `is_current = true`; panel can show superseded/invalid rows. |
| `email_classification_review_events` | operator review event log | Good audit trail for classification review only. |
| `email_response_drafts` | AI/human drafts, version, current flag, validation, safety flags, prompt/input hashes, approval/rejection fields | Draft staleness versus current links/classification is not surfaced as a first-class dashboard state. |
| `email_operational_events` | operational event type, mailbox, message/job ids, reason, payload | Event-type check constraint is repeatedly replaced by migrations. Pipeline diagnostics depend heavily on this table. |

Local eBay context dependencies:

| Table | Current Email Triage use |
|---|---|
| `ebay_orders` | Order number, buyer username/email, tracking, label metadata, status, sale/paid/ship dates. |
| `ebay_order_lines` | Item number, transaction id, custom label, title, internal item id, sale id. |
| `ebay_return_cases` | Return id, order linkage, buyer, status, reason, raw payload clues. |
| `ebay_return_items` | Return item details for operator/draft context. |
| `ebay_return_tasks` | Internal return workflow context. |
| `ebay_return_messages` | Prior return messages summarized for operator context. |
| `ebay_order_tasks` | Internal order workflow context. |
| `ebay_order_label_events` | Tracking/label lookup. |
| `ebay_inventory_links` | SKU/listing/offer bridges to inventory. |
| `ebay_buyer_history_syncs` | Buyer-history freshness for match risk. |
| `ebay_account_history_sync_runs` | Account-history freshness for match risk. |

Migration inventory and risks:

| Migration | Purpose | Risk notes |
|---|---|---|
| `20260520103000_email_triage_microsoft_mailbox_connections.sql` | Microsoft connection and encrypted secret tables | Good service-role-only token boundary. |
| `20260520143000_email_triage_persistence_foundation.sql` | Email mailbox/folder/message/body/sync/job/classification/link foundation | Large foundational surface. Email body table intentionally stores unredacted raw bodies. |
| `20260520170000_email_triage_operational_events.sql` | Operational events table with initial allow-list | Later migrations repeatedly replace `event_type` check. |
| `20260520193000_email_triage_classification_schema_foundation.sql` | Classification columns, constraints, classifier job support | Check constraints are mostly additive/not valid. |
| `20260521120000_email_triage_classification_replay_event.sql` | Adds `classification_replay` to operational events | Drops any event-type check and recreates. |
| `20260521143000_email_triage_workflow_priority_urgency.sql` | Adds classification workflow fields | Classification enum constraints are strict. |
| `20260521200000_email_triage_classification_review_overrides.sql` | Operator review overrides and review events | Good audit support for classification decisions. |
| `20260522120000_email_triage_response_draft_persistence.sql` | Draft persistence | Grants authenticated insert/update with admin RLS policies. |
| `20260523170000_email_triage_sync_import_approved_event.sql` | Adds `sync_import_approved` event type | Drops/recreates event-type check. |
| `20260524123000_email_triage_live_sync_toggle.sql` | Adds `live_sync_enabled`, `classify_imported`, `set_live_sync`; also contains buyer profitability function | This file appears to subsume the named `20260524120000_email_triage_classify_imported_event.sql`, which is not present locally. It also mixes non-email buyer profitability code into an email migration. |
| `20260524124500_email_triage_run_live_refresh_event.sql` | Adds `run_live_refresh`; also contains buyer insight function | Also mixes eBay buyer insight function into email migration. |
| `20260525120000_email_triage_rematch_operational_event.sql` | Adds `rematch_existing` | Current final local allow-list is cumulative. |

`email_operational_events.event_type` conclusion:

- Current final local constraint is cumulative and includes:
  - `processing_requeue`
  - `processing_replay`
  - `sync_replay`
  - `classification_replay`
  - `sync_import_approved`
  - `classify_imported`
  - `set_live_sync`
  - `run_live_refresh`
  - `rematch_existing`
- This is safe only if migrations apply in this exact local order.
- It is fragile for teammate branches because each migration drops any existing event-type check and recreates a hard-coded list. A later or parallel migration can accidentally remove event types it does not know about.
- The specifically requested `20260524120000_email_triage_classify_imported_event.sql` is absent locally. The `classify_imported` event type exists, but it is added in `20260524123000_email_triage_live_sync_toggle.sql`. That is a naming/history drift risk.

Additional migration/config drift:

- `microsoft-auth-start` exists and the frontend calls it, but `supabase/config.toml` does not list a `[functions.microsoft-auth-start]` entry. This may not break a deployment that deploys by function path, but it is a real config drift risk and leaves `verify_jwt` behavior less explicit than the other Microsoft functions.

## 5. Operation Lifecycle Matrix

| Operation | Outlook Fetch | Import | Process | Match | Classify | Draft | Outlook Mutation | eBay Mutation | Operational Event | UI Refresh |
|---|---|---|---|---|---|---|---|---|---|---|
| Preview Outlook Emails | Yes, preview metadata/bodyPreview only | No | No | No | No | No | No | No | No | Preview panel only |
| Import All Likely eBay | Yes, preview then full selected likely messages | Yes, full message/recipients/body | No | No | No | No | No | No | `sync_import_approved` | Preview rows updated, classification/dashboard reload callback |
| Import Selected | Yes, preview then full selected messages | Yes, full message/recipients/body | No | No | No | No | No | No | `sync_import_approved` | Preview rows updated, classification/dashboard reload callback |
| Run Live Refresh | Yes, preview then full likely messages | Yes | Yes | Yes | Yes, capped batch | No | No | No | Parent `run_live_refresh`, child `sync_import_approved`, child `classify_imported`; no process child event | Classification/dashboard/context/draft reload callback |
| Rematch Existing Emails | No | No | Existing stored body read; no required normalization first | Yes, richer matcher | No | No | No | No eBay table writes; writes `email_message_links` | `rematch_existing` | Classification/dashboard/context reload callback |
| Refresh Data | No | No | No | No | No new classification | No | No | No | No | Reloads admin classification view only |
| Refresh Context | No | No | No | No new match | No | No | No | No | No | Reloads selected operator match context only |
| Generate Draft | No | No | Reads stored normalized/body text | Reads existing context | Reads current valid classification | Yes, writes internal draft | No | No | No operational event | Reloads draft and match context only |
| Refresh Drafts | No | No | No | No | No | Reads stored drafts | No | No | No | Reloads draft panel only |
| Toolbar Refresh Latest Messages | Yes, latest 10 Graph previews | No | No | No | No | No | No | No | No | Latest messages panel only |
| Bootstrap Email Persistence | Fetches Graph inbox folder | No messages | No | No | No | No | No | No | Sync run, not operational event | Status/dashboard if manually refreshed |
| Requeue / Replay Ops | No | No import | Enqueues jobs | Depends on job type | Depends on job type | No | No | No | `processing_requeue`, `processing_replay`, or `sync_replay` | Only if dashboard is refreshed |

Manual import behavior summary:

- `Preview Outlook Emails` is safe and read-only except for token health/refresh behavior in some paths.
- `Import All Likely eBay` persists approved messages but intentionally stops before processing/classification.
- `Import Selected` can import selected likely/maybe messages but frontend prevents `not_ebay` and already-imported rows.
- `Run Live Refresh` is the only UI button that currently chains import, process, match, and classify.
- `Rematch Existing Emails` changes only local deterministic email links and operational events.
- Draft generation persists internal drafts but never sends.

## 6. Frontend State Audit

State store:

- `email-triage.state.js` keeps one global state object with:
  - mailbox status and latest messages
  - classification admin data
  - selected classification id and filters
  - message details cache
  - drafts by message id
  - match context by message id
  - inbox preview/import/live/rematch state
  - operational dashboard snapshot
- This is adequate for a single-page admin tool, but stale subviews are easy to create because each operation refreshes a different subset of cached state.

Loading and disabled buttons:

- Inbox buttons compute a single `loading` value from any inbox action.
- All inbox buttons receive `aria-busy` and `is-loading` while any inbox operation is running.
- Availability is controlled separately by disabled flags.
- CSS then gives all disabled primary/secondary/danger buttons `cursor: wait`.
- Result: an unavailable button with no active operation looks busy on hover. Confirmed bug.

Recommended model:

- `disabled` should mean unavailable and use `cursor: not-allowed` or default.
- Busy buttons should be indicated only by `aria-busy="true"` or `.is-loading`.
- Non-active disabled buttons should not inherit wait cursor.

Selected email/classification state:

- `renderAdminClassificationDebug` mutates `state.selectedClassificationId` during render when the selected row is absent or filtered out.
- This works in practice but violates the store/update pattern and makes stale selection behavior harder to reason about.
- Selection is based on loaded classification rows, not all classifications.

Category counts:

- `debugCategoryCounts` and `renderCategorySidebar` count only `data.classifications`.
- `data.classifications` comes from `admin_view`.
- Frontend asks for 100, backend caps to 50.
- Backend does not filter `admin_view` to current valid classifications.
- Therefore `All = 50` means "50 classification rows loaded", not "50 total messages" and not "50 current classifications".

Dashboard state:

- Dashboard state is normalized from three sources:
  - mailbox status
  - sync `pipeline_diagnostics`
  - sync `live_sync_status`
- It is a snapshot and does not auto-refresh after every possible backend mutation.
- UI-triggered import/live/rematch refresh the dashboard through callbacks, but external ops, failed event inserts, and queued jobs require manual refresh.

Stale state risks:

- Import callback reloads classification and dashboard, but imported messages still have no classification until processing/classification happens.
- Rematch callback reloads classification list even though classifications are not recomputed.
- Rematch reloads selected context but does not mark existing classifications/drafts stale.
- Match review updates context only; classification list and draft list are not fully reloaded.
- Draft generation refreshes draft/context but not classification/dashboard.

Frontend syntax checks:

- `node --check` passed for:
  - `email-triage.api.js`
  - `email-triage.state.js`
  - `email-triage.inbox.js`
  - `email-triage.operations.js`
  - `email-triage.classifications.js`
  - `email-triage.drafts.js`
  - `email-triage.diagnostics.js`
  - `email-triage.render-utils.js`
  - `email-triage.js`

No browser/UI mutation testing was performed.

## 7. Backend Function Audit

### `microsoft-auth-start`

- Purpose: create Microsoft OAuth authorization URL.
- Inputs: authenticated Supabase user bearer token, optional return target.
- Writes: none.
- External calls: none.
- Safety: checks active admin via service role before generating URL; signs state with HMAC and expiry.
- Risk: function code exists and frontend calls it, but `supabase/config.toml` does not explicitly configure it.

### `microsoft-auth-callback`

- Purpose: public OAuth callback.
- Inputs: Microsoft `code` and signed `state`.
- Writes:
  - `microsoft_mailbox_connections`
  - `microsoft_mailbox_connection_secrets`
- External calls:
  - Microsoft token endpoint
  - Graph `/me`
  - Graph latest message preview fetch
- Safety:
  - `verify_jwt = false` is appropriate for OAuth callback.
  - State signature and expiry are checked.
  - Admin user from state is revalidated.
  - Refresh token is AES-GCM encrypted before DB persistence.
  - Short-lived proof cookie is HttpOnly.
- Risks:
  - Proof cookie stores an encrypted access token temporarily. Browser JS cannot read it, but it is still credential material in a cookie.
  - Callback CORS is broad, but state verification is the primary defense.

### `microsoft-mailbox-status`

- Purpose: sanitized status for active connection.
- Inputs: admin bearer token.
- Writes: none.
- External calls: none.
- Safety: no secrets returned.
- Risk: low.

### `microsoft-mailbox-disconnect`

- Purpose: disconnect local Microsoft mailbox.
- Inputs: admin bearer token.
- Writes:
  - deletes secret row
  - marks connection disconnected
- External calls: none.
- Safety: does not mutate Outlook.
- Risk: operationally destructive to local connection state, but user-facing and explicit.

### `microsoft-latest-messages`

- Purpose: fetch latest 10 Outlook message previews for POC/status UI.
- Inputs: admin bearer token and either persisted connection or proof cookie.
- Writes:
  - connection health
  - refresh-token rotation when Microsoft returns a new refresh token
- External calls:
  - Microsoft token endpoint
  - Graph `/me/messages`
- Safety: returns preview metadata/body preview only, not full persisted bodies.
- Risk: it is a read operation from Outlook but does rotate token/connection health.

### `microsoft-email-bootstrap`

- Purpose: create provider-neutral email mailbox/folder/sync state.
- Inputs: admin bearer token.
- Writes:
  - `email_mailboxes`
  - `email_folders`
  - `email_sync_states`
  - `email_sync_runs`
  - connection health/token rotation
- External calls:
  - Microsoft token endpoint
  - Graph inbox folder endpoint
- Safety: does not import messages and does not mutate Outlook/eBay.
- Idempotency: uses upserts for mailbox/folder/sync state.
- Failure behavior: marks bootstrap run failed and mailbox error when possible.

### `microsoft-email-sync`

- Purpose: main sync/import/live-refresh/diagnostics engine.
- Inputs:
  - `sync_preview`
  - `sync_import_approved`
  - `process_imported`
  - `classify_imported`
  - `run_live_refresh`
  - `pipeline_diagnostics`
  - `live_sync_status`
  - `set_live_sync`
  - durable sync modes
- Writes:
  - email messages, recipients, bodies
  - processing jobs and links during `process_imported`
  - classifications indirectly through classifier function calls
  - operational events
  - sync states/runs for durable sync modes
  - connection health/token rotation
- External calls:
  - Microsoft token endpoint
  - Graph messages/delta endpoints
  - internal call to `microsoft-email-classify`
- Safety:
  - Preview/import/live refresh do not mutate Outlook.
  - Live refresh explicitly reports no checkpoint update, no scheduler, no polling, no realtime listener, no automatic sending.
  - Import requires explicit confirmation token.
- Idempotency:
  - Message upsert by mailbox/provider id.
  - Processing job upsert by message/job/input version.
  - Operational event insert is not guaranteed to succeed before data writes.
- Failure risks:
  - Manual import can succeed while operational event insert fails; diagnostics then miss imported messages.
  - `process_imported` discovers candidates from recent `sync_import_approved` events, not from all imported messages.
  - `classify_imported` is capped at 10 per live-refresh stage.
  - Live refresh has no processing child operation id.

### `microsoft-email-process`

- Purpose: queue/process normalization and richer deterministic eBay matching; rematch existing imported messages.
- Inputs:
  - enqueue/process modes
  - `process_message`
  - `rematch_existing`
- Writes:
  - `email_message_bodies.normalized_text`
  - `email_processing_jobs`
  - `email_message_links`
  - `email_operational_events` for rematch
- External calls: none.
- Safety:
  - Does not fetch Outlook.
  - Does not mutate Outlook.
  - Does not mutate eBay tables.
- Idempotency:
  - Link upsert improves existing links only when confidence/status/metadata improves.
  - Existing stale/rejected links are not cleaned by rematch.
- Failure risks:
  - Rematch aggregate `rematched` can count messages with candidates even when no link actually changed.
  - Rematch does not trigger reclassification or draft invalidation.

### `microsoft-email-classify`

- Purpose: AI classification, admin views, message detail, operator match context, match review, draft generation/review/diagnostics.
- Inputs:
  - queue/process classification modes
  - `admin_view`
  - `message_detail`
  - `admin_context_view`
  - `operator_match_context`
  - match review modes
  - classification review mode
  - response draft modes
  - draft diagnostics/repair modes
- Writes:
  - classifications
  - processing jobs
  - link review status/metadata
  - classification review events
  - response drafts
- External calls:
  - OpenAI Responses API for classification and drafts.
- Safety:
  - Uses strict JSON schemas.
  - Classification prompt forbids automatic mutations and requires human review for sensitive categories.
  - Draft prompt forbids unverified claims and requires human review.
  - Draft validation blocks refund promises, shipping updates, tracking claims, item-type hallucinations, timelines, return approvals, legal admissions, and compensation promises.
  - Invalid draft outputs do not become current; fallback drafts may become current only after validation.
- Risks:
  - `MAX_LIMIT = 50` caps admin view despite frontend requesting 100.
  - `admin_view` does not filter `is_current = true` or `validation_status = valid`.
  - Classification validation strongly validates schema and detected entities but cannot prove every summary/reasoning sentence is grounded.
  - Draft staleness versus later link changes is not first-class.

### `microsoft-email-ops`

- Purpose: operational status, queue status, matching statistics, requeue/replay/resume controls.
- Inputs:
  - `mailbox_health`
  - `sync_status`
  - `processing_queue_status`
  - `matching_statistics`
  - `requeue_failed_jobs`
  - `replay_processing`
  - `resume_sync_replay`
- Writes:
  - processing jobs
  - operational events
  - may call existing sync path for replay
- External calls:
  - internal Edge Function call to sync for replay.
- Safety:
  - Admin or service-role operator required.
  - Reasons required for mutating replay/requeue controls.
- Risks:
  - Powerful service-role bypass if service role key is exposed.
  - Dashboard does not surface all ops controls/results in one operator workflow.

## 8. Matching / Classification / Draft Audit

### Deterministic matching

Richer matching exists in `microsoft-email-process`:

- Exact order number.
- Exact return id.
- Return context inferred from order/buyer/item clues.
- Tracking and label metadata through `ebay_orders` and `ebay_order_label_events`.
- Item number and transaction id.
- Buyer username with strong-context guard.
- Buyer username alone only as low-confidence unique suggestion.
- Buyer email with masked-email guard.
- SKU/custom label/listing/offer through `ebay_inventory_links`.
- Internal inventory labels/barcodes/QRs.
- Title phrase matching as weak suggestion.
- Buyer/account history freshness through `ebay_buyer_history_syncs` and `ebay_account_history_sync_runs`.

False-positive risks:

- Buyer username alone can still suggest a unique order with low confidence.
- Title phrase and internal label contains matching can link semantically similar items.
- SKU/listing bridges prove inventory context, not order context.
- Return-context inferred matches can be suggested from partial clues.
- Tracking-like tokens in emails can be false positives if carrier/label context is noisy.

Ambiguity risks:

- Multiple orders for the same buyer.
- Same item number across multiple lines/orders.
- Generic titles and labels.
- Masked eBay relay emails.
- Return cases without order linkage.

Stale-data risks:

- Buyer history sync stale/missing.
- Account history stale/missing.
- Inventory links with old `last_synced_at`/`updated_at`.
- eBay return/order tables local-only and not live-refreshed during email actions.
- Rematch can improve links after classification/draft generation without invalidation.

Missing lookup opportunities:

- Durable query support for per-message "why not matched" is limited to job metadata and rematch aggregates.
- UI does not expose all candidate/ambiguity details after rematch.
- Live-refresh embedded matcher is simpler than standalone matcher and should be unified.

### Classification

Strengths:

- Server-side only.
- Uses stored email body and deterministic links.
- Strict output schema.
- Valid current classification supersedes older current AI classifications.
- Invalid classification attempts are stored as invalid/non-current.
- Prompt requires human review for sensitive categories and forbids automatic mutations.

Weaknesses:

- Admin view returns latest AI classification rows without filtering to current valid rows.
- Admin view cap is 50.
- Category sidebar counts loaded rows, not exact DB totals.
- Classification input hash includes deterministic link context, but rematch does not automatically enqueue reclassification when links change.
- Classification count and queue diagnostics are split between admin view and pipeline diagnostics, creating inconsistent operator language.

### Verified context builder

Strengths:

- Draft context uses only confirmed, buyer-facing verified links.
- Weak/suggested links are treated as unverified for buyer-facing drafts.
- Safe context removes raw payloads, costs, fees, taxes, payout, GPS/evidence paths, and private staff comments.
- Safe label metadata is limited to tracking number, shipping barcode number, and label id.

Weaknesses:

- Operator context can show prior return message summaries and internal task operational states to admins. That is useful but needs careful buyer-facing separation.
- Verified context depends on link status being correct and current.
- A confirmed but stale link can become a high-trust draft input until marked stale.

### Draft generation and persistence

Strengths:

- Requires a valid classification.
- Always requires human review.
- Does not send email.
- Does not mutate Outlook.
- Does not mutate eBay.
- Draft body is only returned when validation says content is safe.
- Invalid/error draft attempts are stored but do not become current.
- Conservative fallback drafts are generated when primary draft validation fails on unsupported claims.
- Approval/rejection is internal status only.

Weaknesses:

- Drafts are not automatically invalidated after rematch, match review, or classification override.
- Draft input hash exists, but dashboard/UI do not compare the current draft hash to current context.
- The validator is strong but regex-based; it reduces but cannot eliminate hallucination.
- The fallback draft can still become current valid content, which is safe by design but should be visibly labeled for operators.

## 9. Operational Dashboard Audit

What works:

- Shows mailbox status and live sync state.
- Shows queue state, including queued/running/saturated concepts.
- Shows recent operational events.
- Shows pipeline gaps from import events to processing/classification.
- Shows failed jobs and failure summaries.
- Shows safety flags like no Outlook mutation, no automatic responses, no scheduler/polling/realtime.
- Shows child operation ids for import/classification under live refresh when available.
- Shows duration when event payloads include timing.

Accuracy gaps:

- Preview operations do not write operational events, so preview count is transient UI state only.
- Import counts depend on `sync_import_approved` events. If event insert fails, imported rows exist but diagnostics miss them.
- Processing count is job-based, but live refresh does not create a `process_imported` operational event.
- Classification count is split:
  - admin view returns up to 50 latest AI rows
  - diagnostics counts current valid imported classifications from event-derived imported ids
- Already-imported and skipped counts are visible mainly in operation result rows or recent event payloads, not as durable current totals.
- Rematch count is visible only as aggregate event counts.
- Queue state shows counts but not a clear "will drain / is draining / stuck because no worker" operator status.
- Safety flags are self-reported by functions, not externally verified.
- Pipeline gaps are scoped to event-derived approved imports, not all email_messages.

Operator usability gaps:

- Operators cannot see which rematched messages changed from the result panel.
- Operators cannot easily click from an operational event to message rows.
- Operators cannot see "imported but not processed" as a row-level task list.
- Operators cannot see "processed but unclassified" as a row-level task list.
- Operators cannot see "draft stale because match/classification changed" as a first-class warning.
- Operators cannot distinguish loaded category counts from total category counts.

## 10. Security / Privacy Audit

Token/secrets:

- Refresh tokens are server-side only and encrypted in `microsoft_mailbox_connection_secrets`.
- Browser JS uses Supabase anon key and user session token only.
- Service role key is used only in Edge Functions.
- `microsoft-email-ops` accepts service role key as an operator for server automation; this is powerful and must remain secret.
- OAuth callback proof cookie is HttpOnly and encrypted, but still contains short-lived credential material.

Auth/RLS:

- Email tables have RLS enabled.
- Most email tables revoke authenticated writes and allow admin select policies.
- Edge Functions use service role after explicit admin checks.
- This means Edge Functions, not RLS, are the main mutation boundary.
- `microsoft-auth-callback` correctly has `verify_jwt = false`; other configured Microsoft email functions have `verify_jwt = true`.
- `microsoft-auth-start` lacks explicit config entry in `supabase/config.toml`.

Raw email body exposure:

- Full email body text/html is persisted in `email_message_bodies`.
- Default redaction status is `unredacted`.
- `message_detail` can return capped normalized/body text to admins.
- AI classification and draft generation send stored email text and participant metadata to OpenAI.

Raw eBay data exposure:

- Matching may read `raw_payload` from eBay return cases.
- Admin/draft context sanitizes buyer-facing context and avoids raw payloads, private staff comments, cost/payout/fees/taxes, and evidence paths.
- Some migrations add buyer insight/profitability SQL functions inside email-named migrations. Those functions expose financial summaries to authenticated users with `can_manage_inventory()`, not to Email Triage directly, but the coupling is a migration governance risk.

AI prompt data exposure:

- Classification prompt includes email body, participants, and compact deterministic links.
- Draft prompt includes message, participants, classification, body, deterministic links, verified facts, unknown facts, and safe eBay context.
- Prompt explicitly forbids exposing internal notes and private business data.
- The system should document AI data retention/privacy expectations for customer PII before broader use.

Outbound mutation boundary:

- No inspected code sends email.
- No inspected code calls Microsoft Graph send, reply, patch, move, mark-read, or delete for Email Triage UI operations.
- No inspected code mutates eBay APIs or eBay tables from Email Triage matching/classification/draft paths.

## 11. Known Bugs Confirmed

### Disabled button spinner

Confirmed.

- CSS sets disabled `.primary-btn`, `.secondary-btn`, and `.danger-btn` to `cursor: wait`.
- This affects unavailable buttons even when no operation is running.
- `email-triage.inbox.js` also applies shared loading state across inbox buttons, which makes busy state broader than the action actually running.

Fix direction:

- Disabled unavailable: `cursor: not-allowed` or default.
- Busy action: `.is-loading[aria-busy="true"]` or equivalent.
- Do not use disabled as a proxy for loading.

### Category count showing 50

Confirmed and refined.

- `email-triage.api.js` requests `classificationLimit: 100`.
- `microsoft-email-classify` caps `classificationLimit` at `MAX_LIMIT = 50`.
- `adminClassificationView` uses `.limit(input.classificationLimit)`.
- `renderCategorySidebar` counts `data.classifications`, not DB totals.
- `adminClassificationView` does not filter to `is_current = true` or `validation_status = valid`.

Therefore `All = 50` means "50 loaded AI classification rows", not "50 total emails", "50 total imported messages", or "50 current valid classifications".

### Manual import behavior confusion

Confirmed.

- Import buttons import and persist emails only.
- They do not process, match, classify, or draft.
- Run Live Refresh is the chained operation.
- Refresh Data is classification admin reload only.
- Refresh Context reloads selected local context only.
- Generate Draft only writes an internal draft.

### Pipeline gaps

Confirmed.

These states can exist:

- Imported but unprocessed: yes, after manual import, after event insert failure, when processing is disabled/saturated/failed, or when import events fall outside lookup windows.
- Processed but unclassified: yes, after processing-only runs, classification caps/failures, or classification disabled.
- Classified but stale deterministic links: yes, after rematch or match review changes links.
- Rematched but not reclassified: yes, by design.
- Draft generated from old context: yes, if context changes after draft generation.
- Operational event created without UI refresh: yes, for external ops and non-UI runs; also UI can go stale between refreshes.
- Queued jobs not visible or not draining: partially visible through counts, but not actionable enough.

Acceptability:

- Partial states are acceptable as intermediate system states.
- They are not acceptable as opaque operator states. The UI/dashboard needs explicit rows and next actions.

### Rematch visibility

Confirmed.

- Backend returns `message_ids` and failures.
- UI renders only aggregate counters and safety flags.
- Operational event stores message ids but dashboard rows show summarized counts.
- Operators cannot tell which emails changed or why.

Additional refinement:

- `rematched` can overstate actual changes because a message can have matching candidates but create/update zero links.

### Imported-but-unclassified visibility

Confirmed weak.

- Pipeline diagnostics can show aggregate gaps for event-derived imports.
- Classification panel does not list imported unclassified emails.
- Manual import creates this state intentionally.

## 12. Hidden Bugs / Newly Found Risks

### Critical

- None confirmed in this read-only audit. No sending path or eBay mutation path was found in the inspected Email Triage operations.

### High

- `microsoft-auth-start` config drift: frontend calls `microsoft-auth-start`, function code exists, but `supabase/config.toml` does not explicitly list it.
- Classification panel count semantics are misleading: counts are loaded rows capped at 50, not total/current/valid counts.
- Manual import creates imported-but-unprocessed messages with no immediate row-level follow-up visibility.
- Pipeline diagnostics are event-derived and can miss real imported rows if operational event insertion fails or rows fall outside event windows.
- Rematch updates deterministic links but does not trigger reclassification, draft invalidation, or clear stale classification/draft warnings.
- Migration event-type allow-list replacement is fragile under teammate branch interleaving.

### Medium

- `admin_view` does not filter to current valid classifications and does not return `is_current`, so superseded/invalid rows can affect operator perception.
- Live refresh classification stage is capped at 10, which can leave many imported/processed messages unclassified after a 100-message refresh.
- Live refresh has no first-class processing child operation id.
- Standalone matcher and sync-embedded matcher have different capabilities.
- Rematch result UI hides changed message ids and failures.
- Draft UI does not first-class label stale input hash/context mismatches.
- Match review status changes do not refresh classifications/drafts or mark them stale.
- Dashboard safety flags are self-reported.
- Email migrations include eBay buyer insight/profitability functions, which increases migration scope and reconciliation risk.

### Low

- `renderAdminClassificationDebug` mutates selected state during render.
- The classification state has pagination defaults but no real backend cursor/pagination implementation.
- Preview operation has no durable telemetry event.
- Broad CORS echo-origin pattern relies on bearer-token/admin checks rather than origin allow-listing.

## 13. Recommendations

### Immediate hotfixes

- Fix disabled button cursor/loading state.
- Rename or annotate category counts as "loaded rows" until exact totals exist.
- Add exact dashboard totals for current valid classifications, imported messages, processed messages, and unclassified imported messages.
- Show rematch changed message ids and link counts in the result panel.
- Add a visible warning when current draft/classification may be stale after rematch or match review.
- Add `[functions.microsoft-auth-start]` to `supabase/config.toml` if deployment practice expects config entries.

### Short-term stabilization

- Make manual import either:
  - explicitly "Import only" with a follow-up "Process/Classify imported" action, or
  - chain into process/classify behind a clearly named action.
- Add a `process_imported` operational event so live refresh has complete child operation ids.
- Make pipeline diagnostics table-driven from `email_messages` plus jobs/classifications, not only event-derived message ids.
- Add row-level task lists:
  - imported without processing
  - processed without classification
  - failed processing/classification
  - stale draft/context candidates
- Filter admin classification view to current valid rows by default, with an explicit "history/errors" mode.

### Medium-term architecture improvements

- Unify matching implementation so live refresh and rematch use one deterministic matcher.
- Replace event-type check constraints with either:
  - a lookup enum table
  - a PostgreSQL enum with safe additive migration discipline
  - or one canonical migration that intentionally owns the full set
- Add context-version invalidation:
  - link context hash
  - classification input hash
  - draft input hash
  - current context hash
- Add durable operation graph model for parent/child operations instead of JSON-only child ids.
- Add explicit queue worker/drain status and recommended operator action.

### Future sending-readiness work

- Keep sending disabled until:
  - drafts have verified current context
  - operator approval is required
  - outbound scopes are separate from read scopes
  - send action has a dedicated audit table
  - dry-run and preview are complete
  - irreversible actions have confirmation and rollback/void guidance
- Add policy for AI data exposure, retention, and redaction.
- Add PII redaction options for stored email bodies and AI prompts.
- Add test fixtures for hallucination-sensitive draft categories.

## 14. Proposed Next Steps

### 4F.4C-Hotfix

- Goal: fix confirmed UI/operator confusion without changing backend behavior.
- Files likely touched:
  - `email-triage.css`
  - `email-triage.inbox.js`
  - `email-triage.js`
  - `email-triage.diagnostics.js`
- Migration likely needed: no.
- Edge deploy likely needed: no.
- Test plan:
  - Frontend syntax checks.
  - Browser hover check for disabled buttons.
  - Verify category labels no longer imply totals.
  - Verify rematch result lists changed ids/counts safely.
- Safety guardrails:
  - No Outlook/eBay mutations.
  - No change to import/process/classification semantics.

### 4F.4D

- Goal: make pipeline gaps visible and actionable.
- Files likely touched:
  - `email-triage.diagnostics.js`
  - `email-triage.api.js`
  - `supabase/functions/microsoft-email-sync/index.ts`
- Migration likely needed: maybe no, unless adding structured diagnostics tables.
- Edge deploy likely needed: yes if diagnostics payload changes.
- Test plan:
  - Seed/read-only query fixtures if available.
  - Verify imported-without-processing and processed-without-classification counts against DB queries.
- Safety guardrails:
  - Diagnostics read-only.
  - Do not enqueue or process from dashboard without explicit operator action.

### 4F.4E

- Goal: add first-class processing operation telemetry.
- Files likely touched:
  - `supabase/functions/microsoft-email-sync/index.ts`
  - migrations for event type or operation model
  - dashboard normalizers/renderers
- Migration likely needed: yes if adding event type or child operation fields.
- Edge deploy likely needed: yes.
- Test plan:
  - Process imported dry run/small batch.
  - Verify parent live refresh has import/process/classify child references.
- Safety guardrails:
  - Preserve no Outlook mutation/no sending.
  - Keep processing batch bounded.

### 4F.4F

- Goal: fix classification admin view semantics.
- Files likely touched:
  - `supabase/functions/microsoft-email-classify/index.ts`
  - `email-triage.api.js`
  - `email-triage.js`
  - classification render helpers
- Migration likely needed: no.
- Edge deploy likely needed: yes.
- Test plan:
  - Verify default view filters to current valid rows.
  - Verify totals are exact and separate from loaded rows.
  - Verify invalid/superseded history remains accessible if needed.
- Safety guardrails:
  - Read-only view changes only.
  - No classification recomputation.

### 4F.5

- Goal: unify deterministic matching paths.
- Files likely touched:
  - `supabase/functions/microsoft-email-process/index.ts`
  - `supabase/functions/microsoft-email-sync/index.ts`
  - shared utility if introduced
- Migration likely needed: no, unless adding matcher version columns.
- Edge deploy likely needed: yes.
- Test plan:
  - Fixture messages for order, return, tracking, item, buyer, SKU/title ambiguity.
  - Compare live refresh and rematch outputs.
- Safety guardrails:
  - Matching writes only `email_message_links`.
  - No eBay table mutation.

### 4F.6

- Goal: add context/classification/draft staleness tracking.
- Files likely touched:
  - `microsoft-email-classify`
  - `microsoft-email-process`
  - frontend draft/context panels
  - dashboard diagnostics
- Migration likely needed: maybe, for current context hashes or stale flags.
- Edge deploy likely needed: yes.
- Test plan:
  - Generate draft, rematch, confirm draft shows stale warning.
  - Confirm new draft clears stale warning.
- Safety guardrails:
  - Do not auto-regenerate without explicit operator action.
  - Do not send.

### 4F.7

- Goal: harden migration/event-type governance.
- Files likely touched:
  - Supabase migrations only
  - possibly docs for migration policy
- Migration likely needed: yes.
- Edge deploy likely needed: no unless function event names change.
- Test plan:
  - Local migration reset or dry-run against shadow DB if available.
  - Confirm all current event types accepted.
- Safety guardrails:
  - Additive migration only.
  - Do not drop event history.

### 4F.8

- Goal: privacy and AI exposure stabilization.
- Files likely touched:
  - `microsoft-email-classify`
  - email body persistence/import code
  - docs
- Migration likely needed: maybe, for redaction metadata or prompt audit records.
- Edge deploy likely needed: yes if prompt/body handling changes.
- Test plan:
  - Redaction fixtures.
  - Prompt payload inspection in non-production.
  - Draft hallucination regression fixtures.
- Safety guardrails:
  - No production data mutation during validation.
  - Preserve operator review requirement.

## 15. Final Recommendation

Do not continue building new Email Triage features yet.

Stabilize first. The exact next step should be `4F.4C-Hotfix`: fix disabled/loading state and operator-facing count/rematch visibility issues, while preserving current backend behavior. That is the lowest-risk way to remove the most visible confusion before changing the pipeline itself.

After that, proceed to `4F.4D` and `4F.4E` so imported, processed, classified, failed, skipped, and rematched states are visible from durable diagnostics instead of scattered UI snapshots and event payloads.

Audit limitations:

- No production data was mutated.
- No Outlook email was sent or modified.
- No eBay API or eBay table mutation was performed.
- No deployment was performed.
- No remote Supabase migration state was inspected.
- Frontend syntax checks were run read-only.
