# Step 4A.1 - Email Persistence Audit + Schema Plan

Date: 2026-05-20

## Executive Summary

This is an audit-only planning document for persisting Outlook email locally in PostgreSQL/Supabase for later AI triage, matching, and workflow automation. No schema migration, Edge Function implementation, frontend change, or AI classifier is included in this step.

Recommendation: proceed with an additive email persistence layer anchored to the existing `microsoft_mailbox_connections` table. Store mailbox messages in dedicated normalized tables, keep Microsoft OAuth tokens only in the existing service-role-only secret table, and run all Graph sync through backend Edge Functions or future backend jobs. The design should use Graph immutable IDs, delta tokens, idempotent upserts, sync runs, and per-message processing state so interrupted syncs can resume and AI work can be replayed.

Go/no-go: Go for Step 4A implementation after review, with one condition: confirm whether the production Graph app can request/use `Mail.Read` with `Prefer: IdType="ImmutableId"` and whether the hosted Supabase project has enough storage/retention budget for email bodies and future attachments.

## Agreement Gate: Audit Confirmation

### Files reviewed

- `docs/email-triage/EMAIL_TRIAGE_REPO_AUDIT.md`
- `docs/email-triage/STEP_3_MICROSOFT_GRAPH_POC.md`
- `docs/email-triage/STEP_3_5D_MAILBOX_PERSISTENCE_AUDIT.md`
- `docs/email-triage/STEP_3_5D_SCHEMA_MIGRATION.md`
- `docs/email-triage/STEP_3_5D_CALLBACK_PERSISTENCE.md`
- `docs/email-triage/STEP_3_5D_PERSISTENT_LATEST_MESSAGES.md`
- `docs/email-triage/STEP_3_5D_MAILBOX_STATUS.md`
- `docs/email-triage/STEP_3_5D_DISCONNECT_RECONNECT_CONTROLS.md`
- `email-triage.html`
- `email-triage.js`
- `email-triage.css`
- `supabase/config.toml`
- `supabase/functions/microsoft-auth-start/index.ts`
- `supabase/functions/microsoft-auth-callback/index.ts`
- `supabase/functions/microsoft-latest-messages/index.ts`
- `supabase/functions/microsoft-mailbox-status/index.ts`
- `supabase/functions/microsoft-mailbox-disconnect/index.ts`
- `supabase/functions/generate-inventory-copy/index.ts`
- `supabase/functions/process-inventory-image/index.ts`
- `supabase/functions/list-inventory-upload-images/index.ts`
- `supabase/functions/ebay-feedback-sync/index.ts`
- `supabase/functions/sync-ebay-feedback/index.ts`
- `supabase/functions/scan-no-show/index.ts`
- `supabase/functions/scan-open-break-too-long/index.ts`
- `supabase/functions/enqueue-upcoming-shift-reminders/index.ts`
- `supabase/migrations/20260124184912_remote_schema.sql`
- `supabase/migrations/20260124185608_storefront_phase_3_rls.sql`
- `supabase/migrations/20260314123000_ebay_reviews_homepage.sql`
- `supabase/migrations/20260512143000_worker_inventory_permissions.sql`
- `supabase/migrations/20260513100000_mobile_tray_locations.sql`
- `supabase/migrations/20260514120000_admin_inventory_change_log.sql`
- `supabase/migrations/20260514144500_worker_capture_permissions.sql`
- `supabase/migrations/20260515090000_ebay_pending_orders_worker_checkout.sql`
- `supabase/migrations/20260515124500_admin_ebay_order_closeout.sql`
- `supabase/migrations/20260515133000_admin_ebay_order_reverts.sql`
- `supabase/migrations/20260515140000_live_sale_reserved_stock.sql`
- `supabase/migrations/20260517125000_worker_no_inventory_order_completion.sql`
- `supabase/migrations/20260517131000_batch_no_inventory_order_completion.sql`
- `supabase/migrations/20260517134000_no_inventory_order_evidence_repository.sql`
- `supabase/migrations/20260517135000_no_inventory_completion_rpc_compatibility.sql`
- `supabase/migrations/20260518132000_worker_ebay_order_csv_import.sql`
- `supabase/migrations/20260518134000_worker_ebay_order_history_proof.sql`
- `supabase/migrations/20260518165000_ebay_shipping_label_attachments.sql`
- `supabase/migrations/20260518184500_ebay_label_attachment_audit.sql`
- `supabase/migrations/20260519113000_ebay_label_tracking_metadata_indexes.sql`
- `supabase/migrations/20260519114500_backfill_ebay_label_tracking_metadata.sql`
- `supabase/migrations/20260519133000_extra_ebay_shipping_labels.sql`
- `supabase/migrations/20260520103000_email_triage_microsoft_mailbox_connections.sql`
- `pending-orders.js`
- `ebay-order-history.js`
- `stock.js`
- `stock-checkout.js`
- `stock-storage-transfer.js`
- `additem-assisted.js`
- `admin-changes.js`

### Schema reviewed

Reviewed migrations define these relevant tables and relationships:

- Microsoft mailbox: `microsoft_mailbox_connections`, `microsoft_mailbox_connection_secrets`.
- eBay orders: `ebay_orders`, `ebay_order_lines`, `ebay_order_admin_events`, `ebay_order_revert_events`, `ebay_order_label_events`.
- Inventory: `item_types`, `item_stock_locations`, `locations`, `store_locations`, `stock_transactions`, `inventory_change_log`, `tray_movements`.
- Sales/order closeout: `sales`, `sale_items`, `sale_item_categories`.
- Live-sale matching: `live_sale_sessions`, `live_sale_lots`, `live_sale_lot_items`, `live_sale_events`.
- Existing AI/review/capture support: `ebay_reviews`, `ebay_review_sync_runs`, `capture_jobs`, `capture_job_photos`, plus OpenAI-backed image/copy Edge Functions.

### Functions reviewed

Reviewed Edge Functions and RPC patterns include:

- Microsoft Graph OAuth/status/latest/disconnect functions listed above.
- eBay/inventory RPCs such as `fulfill_ebay_order_line`, `fulfill_ebay_order_line_for_store`, `fulfill_ebay_order_line_with_live_lot`, `admin_close_ebay_order_lines`, `admin_revert_ebay_order_lines`, `complete_ebay_order_lines_without_inventory`, `attach_ebay_shipping_label`, `attach_ebay_extra_shipping_label`, `backfill_ebay_label_tracking_metadata`, `transfer_container_stock_to_tray`, `transfer_tray_stock_to_container`, `reserve_live_sale_item`, and inventory reversion RPCs.
- Background/scheduled patterns: `scan-no-show`, `scan-open-break-too-long`, `enqueue-upcoming-shift-reminders`, `update-metal-spots`, `spot-snapshot`, and eBay feedback sync functions.

### Assumptions made

- Step 3.5D security model is authoritative: refresh tokens remain encrypted in `microsoft_mailbox_connection_secrets`, access tokens are request-local, and browser clients call Edge Functions rather than Graph.
- Step 4A starts as single-mailbox compatible but should not block future multi-mailbox support.
- Email bodies are business records and should be treated as sensitive backend data, not general browser-readable content.
- The first implementation can sync Inbox-focused messages and metadata before adding all folders, attachments, webhooks, or AI classification.
- Existing `public.is_admin()` and `public.can_manage_inventory()` remain the main RLS guardrails.

### Unresolved questions/risk areas

- Retention policy is not yet defined for raw HTML body, normalized text body, and attachments.
- Production mailbox volume is unknown, so index/storage sizing should be watched after initial backfill.
- Graph webhook subscriptions will need public callback verification and subscription renewal strategy later.
- Gmail support may require a provider abstraction, but should not complicate the first Outlook schema.
- eBay customer identity currently lives mostly as order fields, not a normalized customer table, so email-to-customer correlation should initially use deterministic links and a staging table rather than mutate eBay order rows.

## 1. Existing Repo Audit

### Current Microsoft mailbox architecture

The existing Step 3.5D implementation already creates the correct security split:

- `public.microsoft_mailbox_connections` stores non-secret metadata: mailbox email, Microsoft user id, display name, admin actor, status, scopes, tenant authority, token expiry metadata, health timestamps, and safe JSON metadata.
- `public.microsoft_mailbox_connection_secrets` stores encrypted refresh-token material only and is service-role-only.
- `microsoft-auth-start` validates a Supabase admin session and returns the Microsoft authorization URL.
- `microsoft-auth-callback` validates signed OAuth state, exchanges the code server-side, calls Graph `/me`, encrypts the refresh token with Edge Function Web Crypto, and upserts the two mailbox tables.
- `microsoft-latest-messages` refreshes the token server-side, rotates refresh tokens, calls Graph `/me/messages`, and returns sanitized preview fields only.
- `microsoft-mailbox-status` exposes safe connection status.
- `microsoft-mailbox-disconnect` deletes the secret row and marks the metadata row disconnected.

No current code persists Graph message payloads, attachments, body content, AI labels, or drafts.

### Existing eBay order and listing relationships

`ebay_orders` is the order header table. Important identifiers include:

- `order_number` as the unique eBay order id used across UI/import flows.
- `sales_record_number`, `buyer_username`, `buyer_name`, `buyer_email`.
- Sale/payment/shipping timestamps, tracking fields, totals, fee/tax fields, `status`, `raw_payload`, `imported_by`, `imported_at`, `updated_at`.

`ebay_order_lines` links order rows to internal inventory and sale records:

- `order_id` references `ebay_orders`.
- eBay line identifiers: `item_number`, `transaction_id`, `item_title`, `custom_label`.
- Internal links: `internal_item_id` to `item_types`, `stock_location_row_id` to `item_stock_locations`, `location_id` to `locations`, `sale_id`, `sale_item_id`, `stock_transaction_id`.
- Fulfillment state: `quantity`, `fulfilled_quantity`, `line_status`, `fulfilled_by`, `fulfilled_by_email`, `fulfilled_at`, `notes`, `raw_payload`.
- Unique constraint: `(order_id, item_number, transaction_id)`.

There is no separate `ebay_listings` table. Listing/catalog information is currently represented by `item_types`, `storefront_listings`, and eBay order-line fields such as `item_number`, `item_title`, and `custom_label`.

### Existing inventory identifiers

The main inventory identity is `item_types.id`, supported by:

- `barcode`, `qr_code`, `qr_type`, `title`, `description`, `categories`, `photos`, `photo_url`, `dymo_label_url`.
- Pricing and physical fields such as `weight`, `cost`, `sale_price`, `metal`, `purity_basis_points`, `metal_weight_g`, `stone_type`, `item_length`.
- Deletion/recovery fields from reversible inventory migrations.

Physical placement is represented by `item_stock_locations`:

- `id`, `item_id`, `quantity`, `location_id`, lock fields, confirmation metadata, and batch id.

Locations are represented by `locations` and later additive fields:

- Base fields: `location_name`, `location_code`, `type`, `active`, notes.
- Store scope: `store_id`.
- Mobile tray/container hierarchy: `is_tray`, `tray_status`, `tray_current_store_id`, `location_role`, `parent_location_id`, `container_kind`.

Auditability is strong in inventory:

- `stock_transactions` records movement/removal/restoration.
- `inventory_change_log` captures before/after JSON and changed fields.
- `photo_deletion_log`, `change_reversion_log`, `tray_movements`, and live-sale events preserve operational history.

### Existing customers

There is no normalized customer table in the reviewed schema. Customer signals currently exist as denormalized fields:

- `ebay_orders.buyer_username`
- `ebay_orders.buyer_name`
- `ebay_orders.buyer_email`
- `sales.email`
- eBay review/testimonial rows include buyer display/original buyer fields.

Email matching should therefore avoid inventing a broad customer rewrite in Step 4A. Store email participants now, and add correlation tables to link emails to orders/items/customers later.

### Existing AI/review infrastructure

AI exists as Edge Function usage, not as persistent classification tables:

- `generate-inventory-copy` calls OpenAI for listing copy when configured, with placeholder fallback.
- `process-inventory-image` calls OpenAI image APIs for background processing when configured.
- `capture_jobs` and `capture_job_photos` stage assisted photo workflows.

Review/testimonial infrastructure:

- `ebay_reviews` and `ebay_review_sync_runs` support eBay feedback syncing and homepage approval.
- `ebay-feedback-sync` fetches eBay feedback and upserts testimonial/review-style rows.

There are no embedding tables, vector columns, AI classification result tables, email drafts, or workflow queues for email yet.

### Existing Edge Function architecture

Patterns to preserve:

- Edge Functions use `SUPABASE_SERVICE_ROLE_KEY` for backend-only work.
- Browser calls functions with a Supabase access token.
- Admin validation uses `supabase.auth.getUser(accessToken)` plus `employees.role = 'admin'` and `employees.active`.
- Functions return short safe error codes and avoid logging raw secrets.
- CORS is function-local and no-store responses are used for sensitive mailbox endpoints.

### Existing sync/background job patterns

The repo has background-like functions, but no generalized durable queue system:

- Scan functions call database RPCs for timeclock exceptions.
- `enqueue-upcoming-shift-reminders` delegates to a database RPC.
- eBay feedback sync records a sync-run table with started/completed/status counters.
- eBay order import is browser CSV-driven with idempotent order constraints and rollback policies.
- Label backfill is RPC-based and auditable.

For email, the safest repo-aligned pattern is a service-role Edge Function that records a `mailbox_sync_runs` row, upserts messages idempotently, and updates mailbox/folder sync state. A cron or webhook can call the same function later.

## 2. Recommended Email Persistence Architecture

### Core principles

- Add new email tables instead of altering existing eBay/inventory tables in the first schema step.
- Anchor every email row to `microsoft_mailbox_connections.id`.
- Store provider-stable Graph identifiers and normalized/searchable content.
- Keep tokens, delta tokens if considered sensitive, and Graph calls backend-only.
- Make every ingest idempotent using unique constraints.
- Separate message ingestion from AI classification and response drafting.
- Preserve raw-but-bounded provider metadata for replay/debugging without storing token payloads.

### Recommended table groups

#### `email_mailboxes`

Purpose: provider-neutral mailbox/account layer for future multi-mailbox and Gmail support.

Why it exists: `microsoft_mailbox_connections` is Microsoft-specific and currently single-mailbox constrained. A provider-neutral mailbox table lets email persistence avoid hard-coding every downstream table to Microsoft-only concepts while still referencing the current connection row.

Recommendation: introduce it in Step 4A even if it has one row. Reference `microsoft_mailbox_connections.id` for Outlook rows.

#### `email_folders`

Purpose: stores mailbox folders such as Inbox, Sent Items, Archive, Deleted Items, and provider folder ids.

Why it exists: Graph delta sync can be folder-scoped, webhook subscriptions can target folders, and message movement changes `parentFolderId`.

#### `email_messages`

Purpose: canonical message table.

Why it exists: downstream triage, order matching, dedupe, audit, and search all need one stable row per provider message.

#### `email_message_recipients`

Purpose: normalized participants for from/to/cc/bcc/reply-to.

Why it exists: customers may appear in many addresses/names; normalized participant rows make matching and analytics easier without bloating message rows.

#### `email_message_bodies`

Purpose: separates large/sensitive body content from message metadata.

Why it exists: RLS can treat body access more strictly than message headers; future text normalization can be replayed without touching metadata.

#### `email_attachments`

Purpose: attachment metadata and optional storage pointer.

Why it exists: attachment bytes should not be blindly persisted during message ingest. Metadata supports AI triage and later selective download.

#### `email_sync_states`

Purpose: durable delta checkpoint per mailbox/folder/scope.

Why it exists: Graph delta tokens are the foundation for incremental sync and interruption recovery.

#### `email_sync_runs`

Purpose: audit record for each initial/incremental/backfill/webhook sync attempt.

Why it exists: mirrors `ebay_review_sync_runs` and gives operational visibility, counters, errors, and replay context.

#### `email_processing_jobs`

Purpose: backend work queue for post-ingest tasks such as normalization, matching, classification, and later embedding.

Why it exists: AI work should be replayable and decoupled from Graph sync. The initial implementation can enqueue jobs without implementing classifiers.

#### `email_message_classifications`

Purpose: staging table for future AI/human classification results.

Why it exists: keeps AI outputs versioned and auditable without mutating `email_messages`.

#### `email_message_links`

Purpose: links emails to eBay orders/order lines, inventory items, sales, and later customers.

Why it exists: matching confidence and provenance belong in a separate table; order rows should not be polluted with tentative AI guesses.

## 3. Recommended Data Model

### `email_mailboxes`

Recommended columns:

```sql
id uuid primary key default gen_random_uuid(),
provider text not null check (provider in ('microsoft', 'gmail')),
microsoft_connection_id uuid references public.microsoft_mailbox_connections(id) on delete set null,
mailbox_email text not null,
display_name text,
status text not null default 'active'
  check (status in ('active', 'paused', 'error', 'disconnected')),
sync_enabled boolean not null default true,
connected_by uuid references auth.users(id) on delete set null,
created_at timestamptz not null default now(),
updated_at timestamptz not null default now(),
last_sync_at timestamptz,
last_error_code text,
last_error_at timestamptz,
metadata jsonb not null default '{}'::jsonb
```

Constraints/indexes:

- Unique partial index on `(provider, lower(mailbox_email)) where status <> 'disconnected'`.
- Unique index on `microsoft_connection_id where microsoft_connection_id is not null`.
- Index on `(status, sync_enabled, updated_at desc)`.

### `email_folders`

Recommended columns:

```sql
id uuid primary key default gen_random_uuid(),
mailbox_id uuid not null references public.email_mailboxes(id) on delete cascade,
provider_folder_id text not null,
well_known_name text,
display_name text,
parent_provider_folder_id text,
total_item_count integer,
unread_item_count integer,
is_sync_enabled boolean not null default true,
created_at timestamptz not null default now(),
updated_at timestamptz not null default now(),
metadata jsonb not null default '{}'::jsonb
```

Constraints/indexes:

- Unique `(mailbox_id, provider_folder_id)`.
- Index `(mailbox_id, well_known_name)`.
- Index `(mailbox_id, is_sync_enabled)`.

### `email_messages`

Recommended columns:

```sql
id uuid primary key default gen_random_uuid(),
mailbox_id uuid not null references public.email_mailboxes(id) on delete cascade,
folder_id uuid references public.email_folders(id) on delete set null,
provider text not null default 'microsoft',
provider_message_id text not null,
provider_immutable_id text,
internet_message_id text,
conversation_id text,
conversation_index text,
subject text,
subject_normalized text,
from_name text,
from_email text,
sender_name text,
sender_email text,
reply_to_emails text[] not null default '{}'::text[],
received_at timestamptz,
sent_at timestamptz,
created_date_time timestamptz,
last_modified_date_time timestamptz,
web_link text,
importance text,
inference_classification text,
is_read boolean,
is_draft boolean,
has_attachments boolean not null default false,
body_preview text,
body_content_type text,
graph_etag text,
graph_change_key text,
sync_status text not null default 'active'
  check (sync_status in ('active', 'deleted', 'tombstone', 'failed')),
first_seen_at timestamptz not null default now(),
last_seen_at timestamptz not null default now(),
deleted_at timestamptz,
raw_graph_metadata jsonb not null default '{}'::jsonb
```

Constraints/indexes:

- Unique `(mailbox_id, provider_message_id)`.
- Unique `(mailbox_id, provider_immutable_id) where provider_immutable_id is not null`.
- Unique `(mailbox_id, internet_message_id) where internet_message_id is not null`.
- Index `(mailbox_id, received_at desc)`.
- Index `(mailbox_id, conversation_id, received_at)`.
- Index `(mailbox_id, from_email, received_at desc)`.
- Index `(mailbox_id, subject_normalized)`.
- Index `(sync_status, last_seen_at desc)`.
- Optional full-text GIN index later on normalized body/search document.

Microsoft Graph identifiers to persist:

- Persist `id`, preferably with `Prefer: IdType="ImmutableId"` so `provider_message_id` remains stable across folder moves.
- Persist `internetMessageId` for RFC-level dedupe when available.
- Persist `conversationId`, `conversationIndex`, `changeKey`, `@odata.etag`, `parentFolderId`, timestamps, and safe message metadata.
- Persist `webLink` only if useful for admin deep links; treat it as sensitive.

Fields not to persist:

- Access tokens, refresh tokens, authorization codes, OAuth token responses.
- Raw request/response headers that may include bearer tokens or cookies.
- Full Graph user profile payloads beyond selected safe fields.
- Attachment binary content by default.
- Message body in logs.

### `email_message_recipients`

Recommended columns:

```sql
id uuid primary key default gen_random_uuid(),
message_id uuid not null references public.email_messages(id) on delete cascade,
recipient_type text not null check (recipient_type in ('from', 'sender', 'to', 'cc', 'bcc', 'reply_to')),
display_name text,
email text not null,
email_normalized text not null,
position integer not null default 0,
created_at timestamptz not null default now()
```

Constraints/indexes:

- Unique `(message_id, recipient_type, email_normalized, position)`.
- Index `(email_normalized, recipient_type)`.
- Index `(message_id, recipient_type)`.

### `email_message_bodies`

Recommended columns:

```sql
message_id uuid primary key references public.email_messages(id) on delete cascade,
body_text text,
body_html text,
body_text_sha256 text,
body_html_sha256 text,
normalized_text text,
normalized_text_sha256 text,
normalization_version text,
stored_at timestamptz not null default now(),
updated_at timestamptz not null default now(),
redaction_status text not null default 'unredacted'
  check (redaction_status in ('unredacted', 'redacted', 'body_omitted')),
metadata jsonb not null default '{}'::jsonb
```

Recommendation: store `body_text` and normalized text first. Store `body_html` only if needed for response context or audit, and consider size limits. Use hashes to dedupe and detect body changes.

### `email_attachments`

Recommended columns:

```sql
id uuid primary key default gen_random_uuid(),
message_id uuid not null references public.email_messages(id) on delete cascade,
provider_attachment_id text not null,
name text,
content_type text,
size_bytes bigint,
is_inline boolean not null default false,
content_id text,
content_location text,
download_status text not null default 'metadata_only'
  check (download_status in ('metadata_only', 'queued', 'stored', 'failed', 'skipped')),
storage_bucket text,
storage_path text,
sha256 text,
last_error_code text,
created_at timestamptz not null default now(),
updated_at timestamptz not null default now(),
metadata jsonb not null default '{}'::jsonb
```

Constraints/indexes:

- Unique `(message_id, provider_attachment_id)`.
- Index `(download_status, created_at)`.
- Index `(message_id, is_inline)`.

Attachment strategy:

- Ingest metadata during message sync.
- Do not download attachment bytes by default.
- Later selectively store safe attachments in a private bucket such as `email-attachments`.
- Store only storage pointers, hashes, content type, and scan/status metadata in Postgres.

### `email_sync_states`

Recommended columns:

```sql
id uuid primary key default gen_random_uuid(),
mailbox_id uuid not null references public.email_mailboxes(id) on delete cascade,
folder_id uuid references public.email_folders(id) on delete cascade,
sync_scope text not null default 'folder_messages',
delta_link text,
delta_token_hash text,
last_successful_sync_at timestamptz,
last_attempted_sync_at timestamptz,
last_page_started_at timestamptz,
last_page_completed_at timestamptz,
status text not null default 'never_synced'
  check (status in ('never_synced', 'syncing', 'idle', 'error', 'reset_required', 'paused')),
last_error_code text,
last_error_at timestamptz,
consecutive_error_count integer not null default 0,
created_at timestamptz not null default now(),
updated_at timestamptz not null default now(),
metadata jsonb not null default '{}'::jsonb
```

Constraints/indexes:

- Unique `(mailbox_id, folder_id, sync_scope)`.
- Index `(status, last_attempted_sync_at)`.
- Index `(mailbox_id, updated_at desc)`.

Store the full `delta_link` because it is the replay checkpoint. Do not expose it to browser clients.

### `email_sync_runs`

Recommended columns:

```sql
id uuid primary key default gen_random_uuid(),
mailbox_id uuid not null references public.email_mailboxes(id) on delete cascade,
folder_id uuid references public.email_folders(id) on delete set null,
sync_state_id uuid references public.email_sync_states(id) on delete set null,
run_type text not null check (run_type in ('initial_backfill', 'incremental', 'manual_resync', 'webhook', 'replay')),
status text not null default 'running'
  check (status in ('running', 'succeeded', 'failed', 'cancelled')),
started_at timestamptz not null default now(),
completed_at timestamptz,
started_by uuid references auth.users(id) on delete set null,
trigger_source text not null default 'edge_function',
graph_request_count integer not null default 0,
pages_fetched integer not null default 0,
messages_seen integer not null default 0,
messages_inserted integer not null default 0,
messages_updated integer not null default 0,
messages_deleted integer not null default 0,
attachments_seen integer not null default 0,
jobs_enqueued integer not null default 0,
last_error_code text,
last_error_message text,
metadata jsonb not null default '{}'::jsonb
```

Indexes:

- `(mailbox_id, started_at desc)`.
- `(status, started_at desc)`.
- `(run_type, started_at desc)`.

### `email_processing_jobs`

Recommended columns:

```sql
id uuid primary key default gen_random_uuid(),
message_id uuid not null references public.email_messages(id) on delete cascade,
job_type text not null
  check (job_type in ('normalize', 'match_order', 'classify', 'draft_response', 'embed')),
status text not null default 'queued'
  check (status in ('queued', 'running', 'succeeded', 'failed', 'skipped')),
priority integer not null default 100,
attempt_count integer not null default 0,
max_attempts integer not null default 3,
available_at timestamptz not null default now(),
started_at timestamptz,
completed_at timestamptz,
locked_by text,
locked_at timestamptz,
last_error_code text,
last_error_message text,
input_version text,
created_at timestamptz not null default now(),
updated_at timestamptz not null default now(),
metadata jsonb not null default '{}'::jsonb
```

Constraints/indexes:

- Unique `(message_id, job_type, input_version)` to prevent duplicate queued work.
- Index `(status, available_at, priority)`.
- Index `(message_id, job_type, created_at desc)`.

### `email_message_classifications`

Recommended columns:

```sql
id uuid primary key default gen_random_uuid(),
message_id uuid not null references public.email_messages(id) on delete cascade,
source text not null check (source in ('ai', 'human', 'rule')),
classifier_name text,
classifier_version text,
category text not null,
subcategory text,
confidence numeric(5,4),
sentiment text,
priority text,
requires_human_review boolean not null default true,
reasoning_summary text,
evidence jsonb not null default '{}'::jsonb,
created_by uuid references auth.users(id) on delete set null,
created_at timestamptz not null default now()
```

Indexes:

- `(message_id, created_at desc)`.
- `(category, confidence desc)`.
- `(requires_human_review, created_at desc)`.

### `email_message_links`

Recommended columns:

```sql
id uuid primary key default gen_random_uuid(),
message_id uuid not null references public.email_messages(id) on delete cascade,
link_type text not null check (link_type in ('ebay_order', 'ebay_order_line', 'inventory_item', 'sale', 'customer_identity')),
ebay_order_id uuid references public.ebay_orders(id) on delete cascade,
ebay_order_line_id uuid references public.ebay_order_lines(id) on delete cascade,
item_id uuid references public.item_types(id) on delete set null,
sale_id uuid references public.sales(id) on delete set null,
matched_value text,
match_method text not null,
confidence numeric(5,4),
status text not null default 'suggested'
  check (status in ('suggested', 'confirmed', 'rejected', 'stale')),
created_by uuid references auth.users(id) on delete set null,
created_at timestamptz not null default now(),
metadata jsonb not null default '{}'::jsonb
```

Indexes:

- `(message_id, status)`.
- `(ebay_order_id) where ebay_order_id is not null`.
- `(ebay_order_line_id) where ebay_order_line_id is not null`.
- `(item_id) where item_id is not null`.
- Unique suggested/confirmed guard such as `(message_id, link_type, ebay_order_id, ebay_order_line_id, item_id, sale_id)` with null-safe implementation if practical.

## 4. Sync Lifecycle Design

### Initial sync

1. Admin triggers backend sync through an Edge Function, or a cron calls it later.
2. Function validates active admin if manually triggered.
3. Function loads one active `microsoft_mailbox_connections` row and decrypts the refresh token server-side.
4. Function ensures an `email_mailboxes` row exists for the Microsoft connection.
5. Function loads/syncs folders and creates `email_folders`.
6. Function creates `email_sync_state` rows for selected folders, starting with Inbox.
7. Function creates an `email_sync_runs` row with `run_type = initial_backfill`.
8. Function calls Graph message delta endpoint with `Prefer: IdType="ImmutableId"` and selected fields.
9. Each page is upserted into `email_messages`, recipients, body, and attachments metadata inside bounded transactions.
10. After the final delta page, function stores the final `deltaLink`, marks sync state `idle`, and marks run `succeeded`.

### Incremental sync

1. Load `email_sync_states.delta_link`.
2. Create `email_sync_runs` row with `run_type = incremental`.
3. Call the stored delta link.
4. Upsert changed messages and apply delete tombstones.
5. Update `last_seen_at`, `last_modified_date_time`, `graph_change_key`, and body/attachment metadata if changed.
6. Store the new final delta link only after all pages succeed.

### Retry behavior

- Treat Graph 429/503 as retryable with exponential backoff.
- Keep `consecutive_error_count` and `last_error_code` in `email_sync_states`.
- Mark token refresh failures on the existing mailbox connection as `reconnect_required`, matching Step 3.5D.
- Do not discard the prior successful delta link on a failed run.
- Use `email_sync_runs.metadata` for page cursor and safe error details, but not tokens.

### Dedupe behavior

Use layered dedupe:

- Primary: `(mailbox_id, provider_message_id)` where provider id is requested as immutable.
- Secondary: `(mailbox_id, provider_immutable_id)` if different from provider message id.
- Tertiary: `(mailbox_id, internet_message_id)` when available.
- Body hashes for content-change detection, not as primary message identity.
- Recipient rows unique by message/type/email/position.
- Attachment rows unique by message/provider attachment id.

### Partial failure recovery

- Each page should be committed independently after idempotent upserts.
- The sync state should keep the old `delta_link` until the final page succeeds.
- A failed run can be retried from the last successful delta link and reprocess already-seen messages safely.
- If Graph returns an invalid/expired delta token, mark sync state `reset_required` and require a controlled resync/backfill.

### Replay/reprocessing

- Reprocessing should not mean re-fetching Graph unless needed.
- Use `email_processing_jobs` for replayable normalization/classification/matching.
- Keep `email_message_bodies.normalization_version` and classifier versions so new AI logic can enqueue new jobs.
- `email_sync_runs` provides ingest audit; `email_message_classifications` and `email_message_links` provide processing audit.

## 5. AI Readiness Recommendations

### Raw content to store

- Message subject.
- Sender/from/reply-to/to/cc metadata.
- Received/sent timestamps.
- Body preview.
- Text body where available.
- HTML body only if needed, with a retention/size policy.
- Attachment metadata, not bytes by default.
- Safe Graph metadata needed for replay and sync: ids, folder id, etag/change key, flags, importance, conversation ids.

### Normalized content to store

- `subject_normalized`: lowercased, trimmed, whitespace-normalized subject with reply/forward prefixes optionally removed.
- `normalized_text`: body text stripped of HTML, tracking footers where safe, excessive whitespace, and quoted reply chains if a deterministic parser is added later.
- `body_*_sha256` and `normalized_text_sha256`.
- Normalized participant emails.

### Metadata useful for AI

- Direction: inbound/outbound inferred from mailbox address and participants.
- Message age and SLA fields later.
- Has attachments, attachment names/types/sizes.
- Conversation/thread ids.
- Candidate eBay order numbers, item numbers, tracking numbers, buyer usernames, email addresses, and internal barcodes extracted by deterministic rules.
- Prior confirmed links to orders/items.
- Human review flags and status.

### Future embedding/vector compatibility

- Do not implement embeddings yet.
- Add embeddings later in a separate table, for example `email_message_embeddings`, keyed by `message_id`, `embedding_model`, `embedding_version`, and `content_hash`.
- Store chunks separately if bodies are long.
- Keep embedding rows invalidatable by `normalized_text_sha256`.
- If Supabase `pgvector` is enabled later, use a vector column there; otherwise keep schema compatible and defer.

## 6. Security Review

### Preserving Step 3.5D security boundaries

This plan keeps the current boundary:

- Microsoft OAuth tokens remain server-side only.
- Refresh tokens remain encrypted in `microsoft_mailbox_connection_secrets`.
- Access tokens are refreshed in memory inside Edge Functions.
- Browser JavaScript never receives Graph tokens.
- Browser JavaScript never calls Microsoft Graph.
- Browser JavaScript should not call raw sync endpoints directly unless the Edge Function validates admin and performs the sync server-side.

### RLS recommendations

Recommended MVP:

- Enable RLS on every new email table.
- Grant no access to `anon`.
- Grant only admin select to `authenticated` for safe metadata tables if needed.
- Keep body, attachment storage pointers, sync states, sync runs, processing jobs, classifications, and links backend-only until UI requirements are explicit.
- Use service-role Edge Functions for inserts/updates/deletes.

Suggested policy posture:

- `email_mailboxes`: admin select only.
- `email_folders`: admin select only.
- `email_messages`: admin select only for metadata once UI exists.
- `email_message_bodies`: no browser policy initially; expose summaries through Edge Functions.
- `email_sync_states`, `email_sync_runs`, `email_processing_jobs`: admin select may be acceptable for operational UI later, but writes stay service-role only.
- `email_message_classifications`, `email_message_links`: admin select; writes through backend/RPC until human review UI is designed.

### Backend-only data

Keep these out of browser direct table access:

- Refresh tokens and token encryption material.
- Delta links/tokens.
- Raw body HTML until UI need and redaction policy are defined.
- Attachment storage paths and bytes unless delivered through signed, short-lived links after authorization.
- Raw Graph metadata beyond selected safe fields.
- AI prompts/outputs if they include sensitive body excerpts.

### Admin UI safe access later

Admin UI can safely access, through Edge Functions or carefully scoped RLS:

- Connection status.
- Sync health counters.
- Message list fields: subject, sender, received time, body preview, classification summary.
- Confirmed/suggested order links.
- Human review actions.

## 7. Future Expansion Considerations

### Multi-mailbox support

The current `microsoft_mailbox_connections_single_active_uidx` enforces one active mailbox. Keep it for Step 4A MVP if desired, but design email tables with `mailbox_id` everywhere. Later, remove or relax the single-active index and have sync functions iterate active mailboxes.

### Multiple organizations/users

There is no org/tenant table in the reviewed schema. If the app becomes multi-org, add `organization_id` to mailboxes, messages, orders, inventory, and employees in a larger migration. Do not fake this in Step 4A.

### Gmail support later

The provider-neutral `email_mailboxes`, `email_messages`, `email_folders`, and sync tables can support Gmail by adding `provider = 'gmail'` and Gmail connection tables. Keep provider-specific raw ids in provider columns and provider-specific metadata in JSON.

### Webhook subscriptions later

Add later tables:

- `email_webhook_subscriptions`
- `email_webhook_events`

Use webhooks only to wake incremental sync. Do not treat webhook payloads as the source of truth. Delta sync remains the source of truth.

### Queue/job processing later

Start with `email_processing_jobs`. Later, a cron Edge Function or worker can claim jobs with `status = queued`, `available_at <= now()`, and advisory locking/RPC claim semantics. This matches the repo's RPC-centered operational style.

## 8. Step-by-Step Implementation Plan

### 4A.2 - Schema migration

Objective: create email persistence tables, indexes, constraints, RLS, and grants.

Risk level: Medium, because email body storage and RLS mistakes are sensitive.

Dependencies: Step 3.5D mailbox tables and `set_updated_at()`.

Testing strategy:

- Apply migration locally or to staging.
- Verify `anon` has no access.
- Verify normal authenticated users cannot read email tables unless admin policy allows it.
- Verify service role can insert/upsert all tables.
- Verify unique constraints prevent duplicate messages.

### 4A.3 - Mailbox/folder sync state bootstrap

Objective: create an Edge Function or RPC-backed function that ensures `email_mailboxes`, `email_folders`, and `email_sync_states` exist for the active Microsoft connection.

Risk level: Low.

Dependencies: 4A.2 and existing encrypted refresh-token flow.

Testing strategy:

- Run as admin and verify one mailbox row.
- Re-run idempotently and verify no duplicates.
- Disconnect mailbox and verify bootstrap refuses or marks inactive.

### 4A.4 - Initial Inbox message ingestion

Objective: fetch Inbox messages through Graph delta and upsert message metadata, recipients, body text, and attachment metadata.

Risk level: Medium-high due to Graph pagination, body storage, and rate limits.

Dependencies: 4A.3.

Testing strategy:

- Use a small `$top` page size in staging.
- Re-run initial sync and verify counters report updates rather than duplicate inserts.
- Verify no token/delta/body content appears in logs.
- Verify interrupted run can be repeated.

### 4A.5 - Incremental sync with delta checkpointing

Objective: use stored delta links for incremental sync.

Risk level: Medium.

Dependencies: 4A.4.

Testing strategy:

- Send/receive/read/delete test messages.
- Verify changed rows update.
- Verify deleted messages become tombstones rather than hard deletes.
- Verify failed run preserves old delta link.

### 4A.6 - Dedupe hardening and Graph immutable IDs

Objective: enforce immutable id usage and fallback dedupe with `internetMessageId`.

Risk level: Medium.

Dependencies: 4A.4 and 4A.5.

Testing strategy:

- Move messages between folders and verify no duplicate if immutable ids are enabled.
- Test duplicate import/replay.
- Verify unique indexes behave correctly when `internetMessageId` is null.

### 4A.7 - Processing job staging

Objective: enqueue `normalize` and `match_order` jobs after ingest without implementing AI classification.

Risk level: Low.

Dependencies: 4A.4.

Testing strategy:

- Verify one job per message/type/version.
- Re-run sync and verify duplicate jobs are not created.

### 4A.8 - Deterministic order/inventory matching

Objective: populate `email_message_links` from deterministic identifiers only: eBay order number, item number, transaction id, tracking number, buyer email, buyer username, internal barcode/custom label.

Risk level: Medium, because false positives affect workflows.

Dependencies: 4A.7.

Testing strategy:

- Unit-test extraction patterns against real sanitized examples.
- Mark matches as `suggested` unless exact high-confidence identifiers match.
- Verify no eBay order rows are mutated.

### 4A.9 - Admin operational status endpoint

Objective: expose safe sync status and counters through an Edge Function for future UI.

Risk level: Low.

Dependencies: 4A.2 through 4A.5.

Testing strategy:

- Admin can view status.
- Non-admin cannot.
- Response excludes delta links and body content.

### 4A.10 - Manual replay endpoint

Objective: allow admin-triggered replay of processing jobs for selected messages/date windows.

Risk level: Medium.

Dependencies: 4A.7.

Testing strategy:

- Verify replay creates new jobs with new `input_version`.
- Verify old classification/link records are preserved for audit.

## Risks and Tradeoffs

- Storing email bodies improves AI readiness but increases privacy/security exposure. Mitigation: separate body table, restrictive RLS, no direct frontend access initially, and retention limits.
- Delta links simplify incremental sync but are sensitive operational credentials. Mitigation: service-role-only sync state and no UI exposure.
- Graph message ids can change on move unless immutable ids are requested. Mitigation: always send `Prefer: IdType="ImmutableId"` and keep `internetMessageId` fallback.
- A provider-neutral mailbox layer adds one table now but avoids rewriting downstream tables for Gmail/multi-mailbox later.
- Direct deterministic matching is safer than early AI matching. AI should propose classifications later, not mutate operational eBay/inventory state.

## Recommended Next Step

Proceed to Step 4A.2: create a schema migration for the additive email persistence tables, RLS policies, grants, indexes, and updated-at triggers. Do not implement message ingestion or AI classification in the same step.

## Go/No-Go Recommendation

Go, with guardrails. The repository already has the right token security foundation from Step 3.5D and strong audit/RPC patterns from inventory/eBay workflows. The implementation should proceed only as small additive phases, starting with schema and RLS, then sync state bootstrap, then limited Inbox ingestion.
