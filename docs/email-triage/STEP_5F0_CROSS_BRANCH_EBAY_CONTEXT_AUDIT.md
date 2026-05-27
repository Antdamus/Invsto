# Step 5F.0 Cross-Branch eBay Context Audit

Date: 2026-05-27

Status: Audit only. No implementation, schema changes, migration edits, Supabase repair, deploy, or frontend changes were performed.

## Executive Summary

Step 5F should proceed as Outlook thread rendering enriched with stored eBay context.

The merged repo now has enough local eBay/order/buyer/return context to enrich the Email Triage selected-message detail view without changing the mailbox source. Outlook/Microsoft Graph should remain the ingestion and thread source. eBay should not be queried directly from Email Triage in the first 5F implementation because the required context is already present in Supabase tables and RPCs populated by existing eBay sync workers and UI flows.

The safest path is:

1. Render the Outlook conversation from `email_messages`, `email_message_bodies`, and `email_message_recipients`.
2. Resolve deterministic links from `email_message_links`.
3. Use linked orders, order lines, returns, and buyer usernames to read stored eBay context.
4. Add buyer/order/return context cards to the selected-message detail panel.
5. Treat buyer-history and message-log context as operator-only enrichment, not buyer-facing truth for draft text.

No new table appears required before the first 5F implementation. One migration-history issue does need manual attention before depending on mailbox-import operational history: current code writes an `email_operational_events.event_type` value of `mailbox_import`, but the latest local event-type check constraint migration inspected does not include `mailbox_import`. The insert path appears intentionally non-fatal, so imports can continue while event history may be incomplete. This audit did not modify or repair that migration.

Remote migration-applied state was not verified because the Supabase CLI reported that no access token was available. Suspicious migrations are therefore assessed by local SQL content and current code behavior only.

## Existing Source-of-Truth Audit Findings Used

This audit builds on the following documents rather than redefining the architecture:

- `docs/email-triage/STEP_4F_FULL_EMAIL_TRIAGE_ARCHITECTURE_AUDIT.md`
- `docs/email-triage/STEP_5_BETA_READINESS_AUDIT.md`
- `docs/email-triage/STEP_4F_POST_MERGE_EBAY_DATA_AUDIT.md`

Source-of-truth findings carried forward:

- Outlook/Microsoft Graph is the current mailbox source.
- Microsoft Graph access is read-oriented for mailbox import and triage; no inspected flow requires Outlook mutation for Step 5F.
- The Email Triage persistence model is provider-neutral and centered on `email_messages`, `email_message_bodies`, recipients, classifications, response drafts, processing jobs, deterministic links, and operational events.
- Deterministic matching should remain auditable and replayable.
- Email Triage should prefer stored context over direct external API calls inside operator workflows.
- Classification, review, draft, and rematch state should remain reconstructable from stored tables and operational events.
- Step 5F was already expected to use `conversation_id`, `conversation_index`, `internet_message_id`, recipients, body text, and related same-conversation rows for full thread rendering.
- HTML bodies must not be rendered unsafely. A text-first thread renderer is the safer first implementation.
- Dashboard event history is event-table backed and can be incomplete if event-type constraints drift.

## Current Email Triage Data Map

### Outlook and Mailbox Connection Tables

#### `microsoft_mailbox_connections`

Stores the Microsoft tenant/user/mailbox connection, connection status, granted scopes, mailbox email, Graph user identifiers, token expiry metadata, and sync health.

Written by:

- `supabase/functions/microsoft-auth-callback/index.ts`
- `supabase/functions/microsoft-mailbox-disconnect/index.ts`
- sync/status functions that update connection health

Read by:

- `microsoft-mailbox-status`
- `microsoft-latest-messages`
- `microsoft-email-bootstrap`
- `microsoft-email-sync`
- frontend mailbox connection/status panels

Current Email Triage use:

- Establishes and validates the Outlook mailbox source.
- Provides mailbox identity for import, sync, and diagnostics.

5F usefulness:

- Useful only as mailbox provenance and connection health. It should not be the primary thread data source.

#### `microsoft_mailbox_connection_secrets`

Stores encrypted Microsoft OAuth refresh/access token material and related secret metadata.

Written by:

- `microsoft-auth-callback`
- token refresh paths in mailbox Edge Functions

Read by:

- service-role Edge Functions that call Microsoft Graph

Current Email Triage use:

- Enables Graph imports and refreshes.

5F usefulness:

- Not needed for stored thread rendering unless 5F later adds on-demand Graph fetch. First 5F should avoid this dependency.

### Email Persistence Tables

#### `email_mailboxes`

Stores provider-neutral mailbox records, provider type, provider mailbox id/address, display name, sync state, live sync settings, and metadata.

Written by:

- `microsoft-email-bootstrap`
- `microsoft-email-sync`
- mailbox import and live sync paths

Read by:

- sync/import functions
- admin mailbox views
- diagnostics

Current Email Triage use:

- Normalizes the Outlook mailbox into the provider-neutral email model.
- Stores `live_sync_enabled`.

5F usefulness:

- Useful for scoping selected messages and future multi-mailbox thread rendering.

#### `email_folders`

Stores provider folders such as Inbox, Sent, and other Outlook folders with provider ids and display metadata.

Written by:

- bootstrap/sync flows

Read by:

- sync/import flows
- diagnostics

Current Email Triage use:

- Tracks source folder placement and supports mailbox sync.

5F usefulness:

- Useful as optional thread block metadata, especially to distinguish sent/operator replies from inbound buyer messages.

#### `email_messages`

Stores imported email headers and normalized provider metadata. Important columns include message id, provider message id, subject, sender/from fields, timestamps, body preview, body content type, attachment flag, sync status, conversation identifiers, internet message id, web link, and provider metadata.

Written by:

- `microsoft-email-sync`
- `microsoft-email-bootstrap`
- import/live refresh paths using Microsoft Graph data

Read by:

- `microsoft-email-classify` admin views and selected-message detail
- `microsoft-email-process`
- deterministic matcher
- frontend mailbox list/detail
- dashboard and diagnostics

Current Email Triage use:

- Main mailbox-list source.
- Source for message processing, deterministic matching, classification, and selected-message detail.
- Current selected detail reads only a limited message shape.

5F usefulness:

- Primary source for Outlook thread blocks. 5F should extend selected detail to include conversation ids, recipients, internet message id, and web link.

#### `email_message_recipients`

Stores To/Cc/Bcc recipient rows per imported message.

Written by:

- Graph import/sync flows

Read by:

- deterministic matcher
- future thread rendering

Current Email Triage use:

- Supports matching and forensic reconstruction of email participants, though current selected-message UI does not display it.

5F usefulness:

- Required for complete thread rendering and role inference.

#### `email_message_bodies`

Stores body text, normalized text, normalization version, and redaction status. May include provider body metadata depending on import path.

Written by:

- Graph import/sync flows
- body normalization/processing paths

Read by:

- `microsoft-email-classify` selected-message detail
- `microsoft-email-process`
- classifiers
- frontend detail body section

Current Email Triage use:

- Provides normalized/body text for classification and selected-message preview.

5F usefulness:

- Primary body source for thread rendering. First 5F should render text or sanitized HTML only.

#### `email_attachments`

Stores attachment metadata for imported messages.

Written by:

- attachment-aware import paths where enabled

Read by:

- diagnostics and future attachment workflows

Current Email Triage use:

- Limited. Existing import safety flags indicate attachment fetch is not part of mailbox import.

5F usefulness:

- Useful as attachment indicators only. Do not fetch or render arbitrary attachment content in first 5F.

#### `email_sync_states`

Stores per-mailbox sync state, Graph delta links, cursor metadata, and mailbox-import progress metadata.

Written by:

- `microsoft-email-sync`
- mailbox import/live sync paths

Read by:

- `microsoft-email-sync`
- import status and diagnostics

Current Email Triage use:

- Powers durable mailbox import, incremental sync, and mailbox import status.

5F usefulness:

- Useful for warnings about freshness or incomplete import, not for rendering the selected thread itself.

#### `email_sync_runs`

Stores sync/import run records, mode, status, counts, timestamps, and error metadata.

Written by:

- `microsoft-email-sync`
- bootstrap/import/live refresh flows

Read by:

- diagnostics and dashboard views

Current Email Triage use:

- Operational visibility into import and sync activity.

5F usefulness:

- Useful for context freshness warnings if a selected email is from an incomplete import window.

### Processing, Classification, Draft, and Review Tables

#### `email_processing_jobs`

Stores processing jobs for imported messages, job type, status, attempts, errors, and run metadata.

Written by:

- `microsoft-email-sync` prepare/import processing
- `microsoft-email-process`

Read by:

- `microsoft-email-process`
- diagnostics

Current Email Triage use:

- Tracks deterministic-processing and classification-prep work.

5F usefulness:

- Useful for warning if selected message has not been processed or rematched.

#### `email_message_classifications`

Stores AI classification rows with current/superseded state, validation state, category, priority, urgency, risk indicators, prompt/input hashes, model metadata, and explanation.

Written by:

- `microsoft-email-classify`

Read by:

- `microsoft-email-classify` admin list/detail
- frontend mailbox list/detail
- review tooling

Current Email Triage use:

- Drives category navigation, filters, priority/status filters, and detail classification summaries.

5F usefulness:

- Useful as message-level context in the selected detail panel. It should remain separate from eBay buyer/order context.

#### `email_classification_review_events`

Stores review/override events for classifications.

Written by:

- classification review/admin workflows

Read by:

- classification views and audit paths

Current Email Triage use:

- Provides auditability for operator review and correction.

5F usefulness:

- Useful as optional audit context, not required for initial thread rendering.

#### `email_response_drafts`

Stores generated response drafts, model metadata, status, and review lifecycle.

Written by:

- draft-generation workflows

Read by:

- selected-message detail and future response workflows

Current Email Triage use:

- Persists draft output rather than treating it as transient UI state.

5F usefulness:

- Useful if the detail panel shows draft context alongside the full thread. Do not include buyer profitability or internal retained-value facts in buyer-facing draft content.

### Deterministic Matching and Operational Tables

#### `email_message_links`

Stores deterministic links between email messages and local business entities. Current allowed link types include `ebay_order`, `ebay_order_line`, `inventory_item`, `sale`, and `customer_identity`.

Written by:

- `microsoft-email-process`
- shared deterministic matcher
- rematch flows

Read by:

- `microsoft-email-process`
- `operator_match_context`
- selected-message and classification context paths
- future 5F context helper

Current Email Triage use:

- Primary bridge from imported Outlook messages to local eBay/order/item/customer context.
- Stores confidence, evidence, metadata, and current/active status.

5F usefulness:

- Critical. 5F should use this table as the first join point to eBay context. It does not currently have a first-class `ebay_return_case` link type, so return context should initially be reached through matched orders/order lines and metadata.

#### `email_operational_events`

Stores audit events for imports, processing, classification, live refresh, rematch, and dashboard event history.

Written by:

- `microsoft-email-sync`
- `microsoft-email-process`
- `microsoft-email-classify`

Read by:

- diagnostics
- operational dashboard
- event-history panels

Current Email Triage use:

- Provides operator-visible history of runs and replay/rematch activity.

5F usefulness:

- Useful for warnings and audit context. A local migration gap appears to prevent `mailbox_import` events from being valid under the current check constraint, so mailbox-import event history may be incomplete until manually reconciled.

### Edge Functions and Shared Backend Flow

#### `microsoft-auth-start`

Starts Microsoft OAuth flow.

5F usefulness:

- None directly.

#### `microsoft-auth-callback`

Completes OAuth, stores connection and token metadata.

5F usefulness:

- None directly unless 5F later fetches live Graph conversation data.

#### `microsoft-mailbox-status`

Returns mailbox connection/status.

5F usefulness:

- Optional freshness/connection status.

#### `microsoft-mailbox-disconnect`

Disconnects mailbox connection.

5F usefulness:

- None directly.

#### `microsoft-latest-messages`

Fetches latest messages from Graph for preview-style flows.

5F usefulness:

- Avoid for first 5F. Stored messages should be the source.

#### `microsoft-email-bootstrap`

Bootstraps mailbox persistence tables and initial sync state.

5F usefulness:

- Foundational only.

#### `microsoft-email-sync`

Handles mailbox import, import status, prepare mailbox, process imported, classify imported, live refresh, diagnostics, durable backfill/incremental/manual sync, and live sync toggling.

Current important modes include:

- `mailbox_import`
- `mailbox_import_status`
- `prepare_mailbox`
- `process_imported`
- `classify_imported`
- `run_live_refresh`
- `pipeline_diagnostics`
- `live_sync_status`
- `set_live_sync`
- durable sync modes such as `initial_backfill`, `incremental`, and `manual_resync`

5F usefulness:

- Provides the stored mailbox data 5F should render. It should not be expanded to do eBay enrichment unless a small helper is the established local pattern.

#### `microsoft-email-process`

Processes imported emails, runs deterministic matching, stores `email_message_links`, and supports rematch scopes.

Current rematch scopes include:

- selected
- current page
- current filter
- latest
- all imported

5F usefulness:

- Critical upstream dependency. 5F context should be link-table driven rather than performing weak UI-only matching.

#### `microsoft-email-classify`

Classifies messages and serves admin classification views and selected-message detail.

Current selected-message detail returns message basics, body text/normalized text, and latest AI classification. It does not yet return recipients, thread siblings, conversation metadata, or enriched eBay context.

5F usefulness:

- Likely endpoint to extend for selected detail because the frontend already calls it for message detail. 5F should add a composed response rather than separate unrelated frontend queries.

#### `microsoft-email-ops`

Operational helper function for Email Triage.

5F usefulness:

- Optional for diagnostics, not the primary detail endpoint.

#### `operator_match_context`

Returns matched-order context for operator UI.

5F usefulness:

- Reusable source or pattern for compact matched order context. It is not enough for the full buyer-history panel by itself.

#### `_shared/deterministic-email-matcher.ts`

Extracts deterministic identifiers and writes links to `email_message_links`. It now checks order numbers, item numbers, transaction ids, custom labels/SKUs, return ids, tracking numbers, buyer usernames, buyer emails, buyer history freshness, label events, inventory links, and existing links.

5F usefulness:

- Central contract for what context is safe to trust. 5F should consume its stored links and evidence instead of duplicating matching in the UI.

### Frontend Files

#### `email-triage.html`

Contains the mailbox UI shell, category/filter/sort/page controls, detail panel targets, and script imports.

5F usefulness:

- Detail panel will need a thread rendering section and context cards.

#### `email-triage.js`

Main mailbox UI. Handles backend-backed pagination, filters, sorting, selected-message detail rendering, body display, and classification context.

5F usefulness:

- Main frontend file to adapt for thread blocks and eBay context cards.

#### `email-triage.api.js`

Wraps Supabase Edge Function calls for mailbox import, status, prepare mailbox, rematch, and classification/detail endpoints.

5F usefulness:

- Should expose the extended selected-message detail response without scattering Supabase queries through UI code.

#### `email-triage.inbox.js`

Handles mailbox import workflow, import status polling, automatic prepare-mailbox flow, and rematch actions/scopes.

5F usefulness:

- Indirect. Ensures messages are imported, processed, classified, and rematched before 5F detail enrichment is useful.

#### `email-triage.css`

Styles mailbox list/detail, controls, and operational UI.

5F usefulness:

- Will need detail-thread and context-card styles in the implementation step, not in this audit.

## Merged eBay Context Findings

The merged eBay work provides reusable stored data for buyer insight, order history, returns, message logs, photos, and account-archive coverage.

### Core eBay Order Tables

#### `ebay_orders`

Created by `20260515090000_ebay_pending_orders_worker_checkout.sql`.

Key columns:

- `id`
- `order_number`
- `sales_record_number`
- `buyer_username`
- `buyer_name`
- `buyer_email`
- `sale_date`
- `paid_on_date`
- `ship_by_date`
- `shipped_on_date`
- `tracking_number`
- `shipping_service`
- `total_price`
- `net_payout`
- `status`
- `raw_payload`
- `imported_at`
- `updated_at`

Written by:

- `ebay-order-sync`
- `ebay-buyer-history-sync`
- return/order workflow updates where applicable

Read by:

- pending orders UI
- order history UI
- buyer insight RPCs
- deterministic matcher
- Email Triage match context

Likely join keys:

- `order_number`
- `id`
- `buyer_username`
- `buyer_email` only as weak supporting evidence
- `tracking_number` for shipping evidence

Freshness model:

- Current/pending orders are populated by eBay order sync.
- Historical account archive orders are populated by buyer-history sync and account archive scans.
- `updated_at`, raw payload source metadata, and sync-run tables indicate freshness.

Safe reuse by Email Triage:

- Yes. This is the primary eBay order source for 5F context.

#### `ebay_order_lines`

Created by `20260515090000_ebay_pending_orders_worker_checkout.sql`.

Key columns:

- `id`
- `order_id`
- `item_number`
- `transaction_id`
- `item_title`
- `custom_label`
- `quantity`
- price/total fields
- `line_status`
- `internal_item_id`
- `sale_id`
- fulfillment metadata
- `raw_payload`

Written by:

- `ebay-order-sync`
- `ebay-buyer-history-sync`

Read by:

- pending order UI
- order history UI
- buyer insight RPCs
- deterministic matcher
- return queue hydration

Likely join keys:

- `order_id`
- `(item_number, transaction_id)`
- `custom_label`/SKU as supporting evidence
- `internal_item_id`
- `sale_id`

Freshness model:

- Same as `ebay_orders`.

Safe reuse by Email Triage:

- Yes. It should be included in matched order summaries and item context.

### Buyer Insight and Buyer History Tables/RPCs

#### `ebay_buyer_history_syncs`

Created by `20260524173500_ebay_buyer_history_sync_metadata.sql`.

Key columns:

- `buyer_key`
- `buyer_username`
- `status`
- `days_back`
- `max_scanned`
- `scanned`
- `matched`
- `orders_upserted`
- `lines_upserted`
- `skipped_new_open_orders`
- `windows_scanned`
- `last_started_at`
- `last_success_at`
- `last_error_at`
- `last_error_message`
- `raw_payload`

Written by:

- `ebay-buyer-history-sync`

Read by:

- `ebay-buyer-insights.js`
- deterministic matcher freshness checks

UI data supplied:

- "Covered by account archive"
- "orders scanned"
- archive status
- last success/start/error
- days back

Likely join keys:

- normalized buyer username as `buyer_key`
- `buyer_username`

Freshness model:

- Per-buyer sync metadata.

Safe reuse by Email Triage:

- Yes. Use it to explain coverage and stale/missing history warnings.

#### `ebay_account_history_sync_runs`

Created by `20260524173000_ebay_account_history_sync_runs.sql`.

Key columns:

- `id`
- `status`
- `dry_run`
- `days_back`
- `max_scanned`
- `scanned`
- `matched`
- `orders_upserted`
- `lines_upserted`
- `buyers_seen`
- `skipped_new_open_orders`
- `windows_scanned`
- `error_message`
- `raw_payload`
- `started_at`
- `finished_at`

Written by:

- account-wide mode of `ebay-buyer-history-sync`

Read by:

- order history archive UI
- deterministic matcher freshness checks

UI data supplied:

- account archive run coverage and completed archive ranges

Likely join keys:

- not buyer-specific; use as global freshness evidence.

Freshness model:

- Run-level metadata.

Safe reuse by Email Triage:

- Yes for warnings and coverage badges; not for direct buyer facts.

#### `get_ebay_buyer_insights`

Defined/replaced across:

- `20260524124500_email_triage_run_live_refresh_event.sql`
- `20260525101500_net_ebay_buyer_insights_after_returns.sql`
- `20260525103000_buyer_insights_cancellation_exposure.sql`

Key output concepts:

- buyer prior order count
- prior/current value
- returned/net retained value
- cancellation exposure
- average order value
- first prior purchase
- last prior purchase
- recent order rows

Written by:

- migration SQL function definitions only.

Read by:

- `ebay-buyer-insights.js`

UI data supplied:

- Buyer Insight summary
- prior store value
- current + prior value
- average order
- first prior purchase
- last prior purchase
- returns
- cancellations

Likely join key:

- buyer username.

Freshness model:

- Derived at query time from stored eBay order/line/return tables.

Safe reuse by Email Triage:

- Yes, as operator-only context. Do not expose retained value/profitability language in buyer-facing drafts.

#### `get_ebay_buyer_return_value_breakdown`

Defined by `20260525114500_buyer_insights_return_value_breakdown.sql`.

Key output concepts:

- returned value breakdown
- return cases/order linkage by buyer

Read by:

- `ebay-buyer-insights.js`

UI data supplied:

- Returns value details in Buyer Insight.

Likely join key:

- buyer username.

Freshness model:

- Derived at query time from stored return/order tables.

Safe reuse by Email Triage:

- Yes for return context, capped and operator-only.

#### `get_ebay_buyer_value_line_breakdown`

Defined/replaced across:

- `20260525123000_buyer_insights_value_line_breakdown.sql`
- `20260525133000_fix_buyer_insight_line_classification.sql`
- `20260525143100_restore_returned_archived_buyer_insight_lines.sql`

Current output concepts include:

- `lineId`
- `orderId`
- `orderNumber`
- `purchaseAt`
- `shipByDate`
- `orderStatus`
- `lineStatus`
- `itemState`
- `itemNumber`
- `transactionId`
- `customLabel`
- `title`
- quantity
- gross/returned/retained values
- return counts
- open return counts
- return details

Read by:

- `ebay-buyer-insights.js`

UI data supplied:

- value line breakdown
- retained/returned/cancelled/archived/pending item classification

Likely join key:

- buyer username.

Freshness model:

- Derived at query time from stored order, line, and return tables.

Safe reuse by Email Triage:

- Yes if capped. Use summary first; detailed rows should be lazy-loaded or limited.

### Returns, Return Tasks, Message Logs, and Photos

#### `ebay_return_cases`

Created by `20260521123000_ebay_returns_workflow.sql`.

Key columns:

- `id`
- `order_id`
- `order_number`
- `ebay_return_id`
- `buyer_username`
- `return_reason`
- `return_tracking_number`
- `status`
- `opened_at`
- `received_at`
- `closed_at`
- `notes`
- `raw_payload`

Written by:

- return workflow RPCs
- `ebay-return-sync`

Read by:

- order history UI
- return queue UI
- buyer insight RPCs
- deterministic matcher

Likely join keys:

- `order_id`
- `order_number`
- `ebay_return_id`
- `buyer_username`
- `return_tracking_number`

Freshness model:

- Stored from manual workflow and eBay return API sync.

Safe reuse by Email Triage:

- Yes. It is the main return context source.

#### `ebay_return_items`

Created by `20260521123000_ebay_returns_workflow.sql`.

Key columns:

- `return_case_id`
- `order_id`
- `order_line_id`
- `internal_item_id`
- original location fields
- item title/number
- expected/received quantity
- condition/disposition
- notes/metadata

Written by:

- return workflow RPCs
- `ebay-return-sync`

Read by:

- return queue and order history

Likely join keys:

- `return_case_id`
- `order_line_id`
- `internal_item_id`

Freshness model:

- Stored return workflow/API state.

Safe reuse by Email Triage:

- Yes for item-level return detail.

#### `ebay_return_events`

Created by `20260521123000_ebay_returns_workflow.sql`.

Key columns:

- return case/item/order references
- event action
- metadata
- evidence photo fields
- created timestamps and actor fields

Written by:

- return workflow RPCs
- return queue actions

Read by:

- order history and return queue UI

Likely join keys:

- `return_case_id`
- `order_id`
- `order_line_id`

Freshness model:

- Local workflow audit.

Safe reuse by Email Triage:

- Yes for operator audit context. Photo/evidence data should be signed, capped, and never included in drafts.

#### `ebay_return_tasks`

Created by `20260521164500_ebay_return_task_queue.sql`.

Key columns:

- return case reference
- task status/assignee/priority
- question/action metadata
- task metadata

Written by:

- return workflow RPCs
- `ebay-return-sync`
- duplicate-reconciliation migration/workflows

Read by:

- return queue UI

Likely join keys:

- `return_case_id`
- `order_id`
- buyer/order metadata

Freshness model:

- Local operational state, supplemented by return sync.

Safe reuse by Email Triage:

- Yes as internal context. Do not treat task status as eBay platform truth unless backed by case data.

#### `ebay_return_task_events`

Stores audit trail for return task status, assignment, comments, questions, and sync-created events.

Safe reuse by Email Triage:

- Optional, for operator audit only.

#### `ebay_return_messages`

Created by `20260521220500_ebay_return_message_logs.sql`.

Key columns:

- `id`
- `return_case_id`
- `order_id`
- `order_number`
- `ebay_return_id`
- `buyer_username`
- `direction`
- `channel`
- `message_status`
- `message_body`
- `item_title`
- `return_reason`
- `request_amount`
- `page_url`
- `sent_at`
- `logged_at`
- `created_by_email`
- `metadata`

Written by:

- RPC `record_ebay_return_message_log`
- `ebay-return-sync`
- browser extension/manual logging flows

Read by:

- `ebay-order-history.js` return queue message log

UI data supplied:

- eBay message log
- buyer comments
- seller/OG replies
- eBay update messages

Likely join keys:

- `return_case_id`
- `order_id`
- `order_number`
- `ebay_return_id`
- `buyer_username`

Freshness model:

- Mixed: API sync plus manual/extension logging. Treat as stored archive, not complete canonical thread.

Safe reuse by Email Triage:

- Yes, but label clearly as eBay return/message archive. Do not merge it into Outlook thread chronology without source labels.

#### Return photos / buyer photos

Observed sources:

- `ebay_return_tasks.metadata`
- `ebay_return_cases.raw_payload`
- `ebay_return_events` evidence metadata
- return sync storage paths and signed URL hydration in UI

Frontend logic:

- `ebay-order-history.js` extracts complaint details, buyer comments, item images, return file ids, image URLs/blob URLs, and hydrates complaint image files for the return queue.

Likely join keys:

- `return_case_id`
- `ebay_return_id`
- storage metadata in task/case/event payloads

Freshness model:

- Imported from eBay return API and/or manually logged evidence.

Safe reuse by Email Triage:

- Yes for operator-only display if signed URLs are short-lived and capped. Do not pass photos to AI draft generation by default.

### Order History and Pending Order UI Data Sources

#### `pending-orders.js`

Uses `ebay_orders` and `ebay_order_lines` for current pending order cards. Passes buyer context to Buyer Insight:

- current order total
- current order count
- current line count
- current order numbers
- current items

5F reuse:

- Reuse the data pattern, not the whole UI. 5F should read the same tables by matched buyer/order.

#### `ebay-order-history.js`

Important query/data sources:

- `ORDER_HISTORY_LINE_SELECT` from `ebay_order_lines` joined to `ebay_orders`
- `ebay_order_admin_events`
- `ebay_order_revert_events`
- `ebay_order_label_events`
- `ebay_return_events`
- `ebay_return_cases`
- `ebay_return_tasks`
- `ebay_return_task_events`
- `ebay_return_messages`
- `ebay_account_history_sync_runs`

UI sections supplied:

- Order History
- buyer-level grouped history
- Buyer Insight triggers
- return queue
- return message log
- return complaint details
- photos/evidence where available
- account archive sync controls/coverage

5F reuse:

- Reuse query ideas and some rendering patterns. The selected email detail should get data from a backend response rather than reproducing large frontend query graphs.

#### `ebay-buyer-insights.js`

Data sources:

- RPC `get_ebay_buyer_insights`
- RPC `get_ebay_buyer_return_value_breakdown`
- RPC `get_ebay_buyer_value_line_breakdown`
- table `ebay_buyer_history_syncs`
- current pending order context passed in by caller

UI sections supplied:

- Buyer Insight
- prior store value
- current + prior value
- average order
- returns
- cancellations
- first prior purchase
- last prior purchase
- covered by account archive
- orders scanned

5F reuse:

- Strong candidate for adapting summary vocabulary and display. Data should be requested by backend detail endpoint or a dedicated context endpoint to avoid duplicating RPC orchestration in the email UI.

### eBay Edge Functions

#### `ebay-order-sync`

Uses eBay Sell Fulfillment API to sync current paid/awaiting-shipment order data into `ebay_orders`, `ebay_order_lines`, sync runs, reservations, and related local state.

Safe reuse by Email Triage:

- Reuse its stored output. Do not call it directly from selected-message rendering.

#### `ebay-buyer-history-sync`

Uses eBay Sell Fulfillment API order history to backfill historical buyer/account orders and lines. Updates `ebay_buyer_history_syncs` and `ebay_account_history_sync_runs`.

Safe reuse by Email Triage:

- Reuse stored output and freshness metadata. Do not run syncs on selected-message render.

#### `ebay-return-sync`

Uses eBay Post-Order Return API to sync return cases, return items, return tasks, return messages, and return images/files where available.

Safe reuse by Email Triage:

- Reuse stored return/message/photo context. Do not query eBay return API during Email Triage detail rendering.

#### `ebay-inventory-sync`

Syncs inventory links, SKUs, offer/listing identifiers, and public eBay photos.

Safe reuse by Email Triage:

- Reuse only as supporting SKU/listing bridge. It is not proof that an email belongs to a buyer/order.

## Migration Comparison / Reconciliation Findings

This audit inspected local migration files only. Remote migration state could not be verified because `supabase migration list` failed with an access-token error.

### Email Triage Migrations Reviewed

- `20260520103000_email_triage_microsoft_mailbox_connections.sql`
- `20260520143000_email_triage_persistence_foundation.sql`
- `20260520170000_email_triage_operational_events.sql`
- `20260520193000_email_triage_classification_schema_foundation.sql`
- `20260521120000_email_triage_classification_replay_event.sql`
- `20260521143000_email_triage_workflow_priority_urgency.sql`
- `20260521200000_email_triage_classification_review_overrides.sql`
- `20260522120000_email_triage_response_draft_persistence.sql`
- `20260523170000_email_triage_sync_import_approved_event.sql`
- `20260524123000_email_triage_live_sync_toggle.sql`
- `20260524124500_email_triage_run_live_refresh_event.sql`
- `20260525120000_email_triage_rematch_operational_event.sql`
- `20260525143000_email_triage_process_imported_operational_event.sql`

### eBay/Buyer/Order/Return Migrations Reviewed

- `20260515090000_ebay_pending_orders_worker_checkout.sql`
- `20260518165000_ebay_shipping_label_attachments.sql`
- `20260518184500_ebay_label_attachment_audit.sql`
- `20260519113000_ebay_label_tracking_metadata_indexes.sql`
- `20260521123000_ebay_returns_workflow.sql`
- `20260521164500_ebay_return_task_queue.sql`
- `20260521220500_ebay_return_message_logs.sql`
- `20260522103000_ebay_order_coordination_tasks.sql`
- `20260522143000_ebay_inventory_sync.sql`
- `20260524103000_ebay_return_api_sync.sql`
- `20260524173000_ebay_account_history_sync_runs.sql`
- `20260524173500_ebay_buyer_history_sync_metadata.sql`
- `20260525101500_net_ebay_buyer_insights_after_returns.sql`
- `20260525103000_buyer_insights_cancellation_exposure.sql`
- `20260525114500_buyer_insights_return_value_breakdown.sql`
- `20260525123000_buyer_insights_value_line_breakdown.sql`
- `20260525133000_fix_buyer_insight_line_classification.sql`
- `20260525143100_restore_returned_archived_buyer_insight_lines.sql`
- `20260526113000_reconcile_ebay_return_task_duplicates.sql`

### Suspicious or Overlapping Migration Groups

| Migration A | Migration B | Content relationship | Remote applied state | Recommendation |
| --- | --- | --- | --- | --- |
| `20260520170000_email_triage_operational_events.sql` | `20260521120000_email_triage_classification_replay_event.sql` | Similar purpose. Later migration drops/recreates the event-type check to add `classification_replay`. | Not verified | Keep both. This is cumulative constraint evolution, not a duplicate. |
| `20260521120000_email_triage_classification_replay_event.sql` | `20260523170000_email_triage_sync_import_approved_event.sql` | Similar pattern. Later migration adds `sync_import_approved`. | Not verified | Keep both. Do not rename/delete. |
| `20260523170000_email_triage_sync_import_approved_event.sql` | `20260524123000_email_triage_live_sync_toggle.sql` | Similar event-check rewrite. `20260524123000` also adds `live_sync_enabled`, `classify_imported`, `set_live_sync`, and buyer profitability RPC. | Not verified | Keep both. Mixed email/eBay content is awkward but intentional in current history. |
| `20260524123000_email_triage_live_sync_toggle.sql` | `20260524124500_email_triage_run_live_refresh_event.sql` | Similar event-check rewrite. The latter adds `run_live_refresh` and first `get_ebay_buyer_insights`. | Not verified | Keep both. Investigate only if remote history diverges. |
| `20260524124500_email_triage_run_live_refresh_event.sql` | `20260525101500_net_ebay_buyer_insights_after_returns.sql` | Both define/redefine buyer insight behavior. Later migration updates net/return math. | Not verified | Keep both. This is function evolution. |
| `20260525101500_net_ebay_buyer_insights_after_returns.sql` | `20260525103000_buyer_insights_cancellation_exposure.sql` | Similar function replacement. Later migration exposes cancellation value/rows. | Not verified | Keep both. This is function evolution. |
| `20260525123000_buyer_insights_value_line_breakdown.sql` | `20260525133000_fix_buyer_insight_line_classification.sql` | Same RPC replacement, later classification fix. | Not verified | Keep both. |
| `20260525133000_fix_buyer_insight_line_classification.sql` | `20260525143100_restore_returned_archived_buyer_insight_lines.sql` | Same RPC replacement, later restores returned archived line behavior. | Not verified | Keep both. Current behavior should be from the latest migration. |
| `20260521123000_ebay_returns_workflow.sql` | `20260524103000_ebay_return_api_sync.sql` | Overlapping return domain, different purpose. One creates workflow/cases/items/events; the other adds API sync run/freshness support. | Not verified | Keep both. |
| `20260521164500_ebay_return_task_queue.sql` | `20260526113000_reconcile_ebay_return_task_duplicates.sql` | Same task domain. Later migration appears corrective/reconciliation-oriented. | Not verified | Keep both; inspect manually before any future cleanup. |

### Migration Issue Requiring Manual Attention

Current `microsoft-email-sync` code writes `email_operational_events.event_type = 'mailbox_import'` for mailbox import audit rows. The latest inspected local event-type check constraint migration, `20260525143000_email_triage_process_imported_operational_event.sql`, includes:

- `processing_requeue`
- `processing_replay`
- `sync_replay`
- `classification_replay`
- `sync_import_approved`
- `process_imported`
- `classify_imported`
- `set_live_sync`
- `run_live_refresh`
- `rematch_existing`

It does not include `mailbox_import`.

Observed code behavior appears non-fatal: the event insert helper returns `null` and logs on failure, allowing import to continue. The operational dashboard/event history may therefore miss mailbox-import events.

Recommendation:

- Do not touch this in the audit.
- Before relying on mailbox-import event history in implementation, manually inspect remote migration state and add/reconcile the missing allowed event type if confirmed.
- Consider a future safer event-type strategy, because repeated drop/recreate check constraints are easy to drift across branches.

### Migrations That Should Not Be Touched Now

- All buyer-insight function replacement migrations should remain in history.
- All return workflow/task/message/API migrations should remain in history.
- Email operational-event migrations should not be deleted or renamed solely because they look similar.
- The mixed email/eBay migrations from `20260524123000` and `20260524124500` should remain unless a deliberate migration-history reconciliation is planned with remote state in hand.

## Integration Opportunities

### Matched Order Summary

Use:

- `email_message_links`
- `ebay_orders`
- `ebay_order_lines`
- `operator_match_context` query pattern

Preferred join:

1. `email_message_links` active/current links for selected `email_message_id`.
2. `ebay_order` links by `ebay_order_id`.
3. `ebay_order_line` links by `ebay_order_line_id`, then join to `ebay_orders`.
4. Secondary lookup by order number only if the deterministic matcher stored it in metadata/evidence.

5F display:

- order number
- buyer username
- order status
- paid/sale/ship dates
- item titles/SKUs
- tracking/label status where useful
- link confidence and evidence

### Buyer Username and Buyer Identity

Use:

- `ebay_orders.buyer_username`
- `ebay_return_cases.buyer_username`
- deterministic link metadata/evidence

Preferred join:

- Verified matched order first.
- Return case buyer username second.
- Extracted buyer username only as weak context with warning.
- Sender email should not be used as the primary buyer-history join.

5F display:

- buyer username
- buyer name/email only if already present in stored order data and needed for operator resolution
- confidence and source label

### Buyer Prior Purchase History

Use:

- RPC `get_ebay_buyer_insights`
- RPC `get_ebay_buyer_value_line_breakdown`
- table `ebay_buyer_history_syncs`

Preferred join:

- buyer username from a verified matched order or return case.

5F display:

- prior order count
- prior retained/store value
- average order
- first prior purchase
- last prior purchase
- capped recent/history rows
- account archive coverage

### Buyer Total Prior Retained Value and Average Order Value

Use:

- `get_ebay_buyer_insights`
- `get_ebay_buyer_value_line_breakdown`

Preferred join:

- buyer username from matched order context.

5F display:

- operator-only metrics.
- Use neutral wording like "retained value" or "historical value"; do not include in customer-facing drafts.

### Returns and Cancellations History

Use:

- `get_ebay_buyer_insights`
- `get_ebay_buyer_return_value_breakdown`
- `ebay_return_cases`
- `ebay_return_items`
- `ebay_return_tasks`
- `ebay_return_events`

Preferred join:

- return case by `order_id`, `order_number`, `ebay_return_id`, or verified buyer username.

5F display:

- return count
- open return count
- cancellation count/value
- current return case status
- return reason
- return tracking if relevant

### Current Pending Orders

Use:

- `ebay_orders`
- `ebay_order_lines`

Preferred join:

- buyer username from verified match.
- Filter to current/pending statuses.

5F display:

- pending order count
- pending total
- order numbers/items
- ship-by dates

### Account Archive Coverage

Use:

- `ebay_buyer_history_syncs`
- `ebay_account_history_sync_runs`

Preferred join:

- `buyer_key`/buyer username for per-buyer coverage.
- account run rows for global archive freshness.

5F display:

- covered/not covered by account archive
- days back
- scanned/matched counts
- last successful sync
- stale/missing warning

### Related eBay Message Log

Use:

- `ebay_return_messages`
- `ebay_return_cases`
- `ebay_return_tasks`

Preferred join:

- return case id
- eBay return id
- order id/order number
- buyer username only as fallback and with cap

5F display:

- separate "eBay message log" panel, clearly distinct from Outlook conversation.
- source labels: buyer, seller/OG, eBay update.
- sent/logged timestamps.

### Buyer Comments, Seller Replies, Photos

Use:

- `ebay_return_messages.message_body`
- `ebay_return_tasks.metadata`
- `ebay_return_cases.raw_payload`
- `ebay_return_events` evidence metadata
- storage signed URL hydration pattern from return queue UI

Preferred join:

- return case id or eBay return id.

5F display:

- buyer comment excerpts and seller/OG replies as internal context.
- photos only as explicitly labeled return evidence, with signed/capped access.

## Risks / Unknowns

### Weak Matching

Buyer username, buyer email, item number, and SKU can all be weak on their own. 5F should not enrich a selected email with full buyer history unless the buyer identity comes from a verified order, return case, or sufficiently confident deterministic link.

### Stale eBay Archive Data

Buyer history depends on completed archive scans and per-buyer syncs. 5F should show stale/missing coverage warnings from `ebay_buyer_history_syncs` and `ebay_account_history_sync_runs`.

### Multiple Buyer Aliases

The same human may have multiple eBay usernames, and usernames may appear with casing/normalization differences. Use normalized buyer keys where available and avoid merging separate usernames without explicit evidence.

### Outlook Thread vs eBay Message Log

Outlook `conversation_id` and eBay return/message logs are different communication systems. They should be displayed as separate timelines unless there is a direct stored link.

### Missing Order IDs

Some emails will have no order number or only weak clues. 5F should render the thread even when matched context is empty.

### Ambiguous Item IDs

Item number without transaction id can match multiple orders. The deterministic matcher already treats this as ambiguous/suggested in some cases. 5F should surface ambiguity instead of picking a buyer.

### Return Case Link Type Gap

`email_message_links` does not currently allow a first-class `ebay_return_case` link type. Return case ids can appear in link metadata and can be reached through matched orders. If return-case linking becomes a primary workflow, a future migration may be appropriate, but it is not required for first 5F.

### Personal/Private Data Exposure

Order raw payloads, buyer names/emails, return comments, photos, internal notes, and retained-value metrics are sensitive. 5F should:

- return only needed fields
- avoid raw payload passthrough
- cap rows
- keep photos signed/temporary
- keep retained-value context operator-only
- avoid feeding sensitive internal metrics into customer-facing drafts by default

### Performance

Buyer insight RPCs and value line breakdowns should not run for every mailbox list row. They are appropriate for selected detail only, ideally cached per buyer and capped.

### Migration Drift

The `mailbox_import` event-type gap indicates the operational-event constraint remains fragile. Manual migration inspection is needed before any cleanup or before relying on import event history.

## Recommended 5F Strategy

5F should not be Outlook-only. It should be Outlook thread rendering plus stored eBay context enrichment.

Recommended answers:

- Should 5F use Outlook thread data only? No. Use Outlook data for the thread itself, but enrich it with stored eBay context when deterministic links are available.
- Should 5F enrich Outlook thread data with existing eBay buyer/order context? Yes.
- Should Email Triage query eBay directly? No, not for first 5F.
- Should Email Triage reuse existing stored eBay tables instead? Yes.
- Do we need a migration before 5F? Not for the core thread/context response. Manual migration attention is needed for the `mailbox_import` event-type gap if event history is part of the next release gate.
- Which existing tables/functions should 5F read? `email_messages`, `email_message_bodies`, `email_message_recipients`, `email_message_links`, `email_message_classifications`, `email_response_drafts`, `ebay_orders`, `ebay_order_lines`, `ebay_return_cases`, `ebay_return_items`, `ebay_return_messages`, `ebay_buyer_history_syncs`, `ebay_account_history_sync_runs`, and buyer insight RPCs.
- Which merged files/components should be reused or adapted? Reuse data contracts and display ideas from `ebay-buyer-insights.js`, `ebay-order-history.js`, `pending-orders.js`, `operator_match_context`, and `_shared/deterministic-email-matcher.ts`. Do not copy large frontend query graphs into Email Triage.

Implementation shape:

1. Extend the selected-message detail backend response.
2. Build a backend context helper that starts from `email_message_links`.
3. Fetch thread blocks from stored Outlook messages in the same `conversation_id`.
4. Fetch matched eBay context from stored tables/RPCs.
5. Return warnings for weak/stale/ambiguous context.
6. Render the Outlook thread and eBay context as adjacent but distinct panels.

## Proposed 5F Data Contract

```ts
{
  ok: true,
  mode: "message_detail",
  message: {
    id: string,
    mailbox_id: string,
    subject: string | null,
    from: {
      name: string | null,
      email: string | null
    },
    sender: {
      name: string | null,
      email: string | null
    },
    recipients: {
      to: Array<{ name: string | null; email: string | null }>,
      cc: Array<{ name: string | null; email: string | null }>,
      bcc: Array<{ name: string | null; email: string | null }>
    },
    reply_to_emails: string[],
    received_at: string | null,
    sent_at: string | null,
    internet_message_id: string | null,
    conversation_id: string | null,
    conversation_index: string | null,
    web_link: string | null,
    body_preview: string | null,
    body_source: "body_text" | "normalized_text" | "preview" | "missing",
    body_text: string | null,
    body_html_available: boolean,
    body_truncated: boolean,
    redaction_status: string | null
  },
  thread_blocks: [
    {
      block_id: string,
      source_message_id: string,
      kind: "stored_message" | "quoted_history" | "body_fallback",
      role: "buyer" | "operator" | "platform" | "unknown",
      sender_name: string | null,
      sender_email: string | null,
      received_at: string | null,
      sent_at: string | null,
      text: string | null,
      html_sanitized: string | null,
      confidence: "stored_message" | "heuristic",
      warnings: string[]
    }
  ],
  classification: {
    id: string | null,
    category: string | null,
    priority_level: string | null,
    urgency_level: string | null,
    validation_status: string | null,
    is_current: boolean | null,
    summary: string | null
  },
  matched_context: {
    links: [
      {
        id: string,
        link_type: "ebay_order" | "ebay_order_line" | "inventory_item" | "sale" | "customer_identity",
        confidence: string | null,
        evidence: unknown,
        metadata: unknown
      }
    ],
    orders: [
      {
        id: string,
        order_number: string,
        buyer_username: string | null,
        status: string | null,
        sale_date: string | null,
        paid_on_date: string | null,
        ship_by_date: string | null,
        shipped_on_date: string | null,
        total_price: number | null,
        net_payout: number | null,
        tracking_number: string | null
      }
    ],
    order_lines: [
      {
        id: string,
        order_id: string,
        item_number: string | null,
        transaction_id: string | null,
        custom_label: string | null,
        item_title: string | null,
        quantity: number | null,
        line_status: string | null,
        internal_item_id: string | null,
        sale_id: string | null
      }
    ],
    items: [
      {
        id: string,
        source: "inventory_item" | "sale" | "order_line",
        title: string | null,
        sku: string | null
      }
    ],
    buyer: {
      username: string | null,
      name: string | null,
      email: string | null,
      matched_from: "order" | "order_line" | "return_case" | "deterministic_hint" | null,
      confidence: "confirmed" | "suggested" | "weak" | "none",
      history_sync: {
        status: string | null,
        days_back: number | null,
        scanned_orders: number | null,
        matched_orders: number | null,
        last_success_at: string | null,
        last_error_message: string | null
      } | null
    },
    returns: [
      {
        id: string,
        order_id: string | null,
        order_number: string | null,
        ebay_return_id: string | null,
        buyer_username: string | null,
        status: string | null,
        return_reason: string | null,
        opened_at: string | null,
        closed_at: string | null,
        return_tracking_number: string | null
      }
    ],
    buyer_history_summary: {
      source: "get_ebay_buyer_insights",
      prior_order_count: number | null,
      pending_order_count: number | null,
      gross_value: number | null,
      retained_value: number | null,
      average_order_value: number | null,
      return_count: number | null,
      open_return_count: number | null,
      cancellation_count: number | null,
      first_prior_purchase_at: string | null,
      last_prior_purchase_at: string | null,
      coverage: {
        covered_by_account_archive: boolean,
        days_back: number | null,
        scanned_orders: number | null,
        matched_orders: number | null,
        last_success_at: string | null,
        status: string | null
      }
    } | null,
    buyer_value_line_breakdown: [
      {
        line_id: string,
        order_number: string | null,
        purchase_at: string | null,
        item_state: "cancelled" | "return" | "archived" | "pending" | "successful" | "unknown",
        title: string | null,
        gross_value: number | null,
        returned_value: number | null,
        retained_value: number | null
      }
    ],
    ebay_message_log: [
      {
        id: string,
        return_case_id: string | null,
        order_number: string | null,
        ebay_return_id: string | null,
        direction: "outbound" | "inbound" | "internal",
        channel: string | null,
        message_status: string | null,
        message_body: string | null,
        sent_at: string | null,
        logged_at: string | null
      }
    ],
    photos: {
      return_complaint_images: Array<{
        label: string | null,
        signed_url: string,
        expires_at: string | null
      }>,
      return_evidence_photos: Array<{
        label: string | null,
        signed_url: string,
        expires_at: string | null
      }>
    }
  },
  warnings: [
    {
      code:
        | "no_thread_messages"
        | "weak_buyer_match"
        | "ambiguous_order_match"
        | "stale_buyer_history"
        | "missing_buyer_history"
        | "missing_return_case_link"
        | "mailbox_import_event_type_not_migrated"
        | "html_body_not_rendered",
      message: string,
      severity: "info" | "warning" | "error"
    }
  ]
}
```

## Concrete Next Steps

1. Manually inspect remote migration state before any migration cleanup or operational-event release gate.
2. If confirmed, add/reconcile the missing `mailbox_import` allowed event type in a separate migration step, not inside 5F UI work.
3. Add a backend selected-message context helper that starts from `email_message_links`.
4. Extend `adminMessageDetail` to return recipients, conversation metadata, thread blocks, and stored matched context.
5. Render Outlook conversation blocks from stored `email_messages` and `email_message_bodies`.
6. Add matched order and order-line summary cards.
7. Add buyer insight summary from stored RPCs/tables using verified buyer username only.
8. Add return context and eBay message-log panel when a linked order/return case exists.
9. Add fallback states for no match, weak match, stale archive, and ambiguous matches.
10. Test with real emails covering strong order matches, return-case matches, weak buyer-only matches, ambiguous item matches, and no matches.

## Files / Tables / Migrations Reviewed

### Planning and Audit Documents

- `docs/email-triage/STEP_4F_FULL_EMAIL_TRIAGE_ARCHITECTURE_AUDIT.md`
- `docs/email-triage/STEP_5_BETA_READINESS_AUDIT.md`
- `docs/email-triage/STEP_4F_POST_MERGE_EBAY_DATA_AUDIT.md`

### Email Triage Backend Files

- `supabase/functions/microsoft-auth-start/index.ts`
- `supabase/functions/microsoft-auth-callback/index.ts`
- `supabase/functions/microsoft-mailbox-status/index.ts`
- `supabase/functions/microsoft-mailbox-disconnect/index.ts`
- `supabase/functions/microsoft-latest-messages/index.ts`
- `supabase/functions/microsoft-email-bootstrap/index.ts`
- `supabase/functions/microsoft-email-sync/index.ts`
- `supabase/functions/microsoft-email-process/index.ts`
- `supabase/functions/microsoft-email-classify/index.ts`
- `supabase/functions/microsoft-email-ops/index.ts`
- `supabase/functions/operator_match_context/index.ts`
- `supabase/functions/_shared/deterministic-email-matcher.ts`

### eBay Backend Files

- `supabase/functions/ebay-order-sync/index.ts`
- `supabase/functions/ebay-buyer-history-sync/index.ts`
- `supabase/functions/ebay-return-sync/index.ts`
- `supabase/functions/ebay-inventory-sync/index.ts`

### Frontend Files

- `email-triage.html`
- `email-triage.js`
- `email-triage.api.js`
- `email-triage.inbox.js`
- `email-triage.css`
- `ebay-buyer-insights.js`
- `ebay-order-history.js`
- `pending-orders.js`
- `ebay-returns.html`
- `pending-orders.html`
- `ebay-order-history.html`
- `tools/ebay-og-order-link-extension/content.js`

### Tables and RPCs Reviewed

- `microsoft_mailbox_connections`
- `microsoft_mailbox_connection_secrets`
- `email_mailboxes`
- `email_folders`
- `email_messages`
- `email_message_recipients`
- `email_message_bodies`
- `email_attachments`
- `email_sync_states`
- `email_sync_runs`
- `email_processing_jobs`
- `email_message_classifications`
- `email_classification_review_events`
- `email_response_drafts`
- `email_message_links`
- `email_operational_events`
- `ebay_orders`
- `ebay_order_lines`
- `ebay_order_label_events`
- `ebay_order_tasks`
- `ebay_order_task_events`
- `ebay_inventory_links`
- `ebay_inventory_sync_runs`
- `ebay_buyer_history_syncs`
- `ebay_account_history_sync_runs`
- `ebay_return_cases`
- `ebay_return_items`
- `ebay_return_events`
- `ebay_return_tasks`
- `ebay_return_task_events`
- `ebay_return_messages`
- `ebay_return_sync_runs`
- `get_ebay_buyer_insights`
- `get_ebay_buyer_return_value_breakdown`
- `get_ebay_buyer_value_line_breakdown`
- `record_ebay_return_message_log`
- `open_ebay_return_case`
- `assign_ebay_return_task`
- `create_ebay_return_question_task`
- `update_ebay_return_task_status`
- `sync_ebay_return_tasks_after_intake`

### Migration Remote-State Note

Remote migration state was not verified. The local Supabase CLI reported:

```text
Access token not provided. Supply an access token by running supabase login or setting the SUPABASE_ACCESS_TOKEN environment variable.
```

No migration repair, rename, delete, push, or schema change was performed.
