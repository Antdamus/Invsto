# Step 4D.0 eBay Order Context Audit

Audit date: 2026-05-23  
Scope: documentation-only audit of existing eBay/order/inventory/return/customer/task context for future email triage matching and AI draft enrichment.

## Executive Summary

The repo already has a meaningful eBay operations data model:

- `ebay_orders` and `ebay_order_lines` are the core eBay order header and line tables.
- Buyer/customer identity currently lives mostly on `ebay_orders`, not in a separate customer table.
- Item/listing/inventory context is split between eBay line data (`item_number`, `transaction_id`, `item_title`, `custom_label`) and internal inventory/sales tables (`item_types`, `item_stock_locations`, `sales`, `sale_items`, `stock_transactions`).
- Return/refund context lives in `ebay_return_cases`, `ebay_return_items`, `ebay_return_events`, `ebay_return_tasks`, `ebay_return_task_events`, and `ebay_return_messages`.
- Internal order coordination lives in `ebay_order_tasks` / `ebay_order_task_events`; general worker/admin tasks live in `team_tasks` / `team_task_events`.
- Email persistence already has `email_message_links`, and `microsoft-email-process` already implements a conservative deterministic `match_order` job.
- The current AI classifier/drafter only receives compact deterministic link summaries, not rich order, line, shipping, return, task, or item facts.

For Step 4D.1, extend the existing matching layer rather than replacing it. For Step 4D.2, add a server-side, read-only order-context builder that injects explicit DB facts into draft generation. Do not let the model infer missing item/order details.

## Current eBay / Order / Inventory Schema Map

### `public.ebay_orders`

Migration: `supabase/migrations/20260515090000_ebay_pending_orders_worker_checkout.sql`

Purpose: eBay order header imported from eBay order reports and updated by fulfillment, label capture, closeout, cancellation, and return workflows.

Important columns:

- Identifiers: `id`, `order_number` unique, `sales_record_number`, `ebay_shipment_id`.
- Buyer/customer: `buyer_username`, `buyer_name`, `buyer_email`.
- Dates/status: `sale_date`, `paid_on_date`, `ship_by_date`, `shipped_on_date`, `status`.
- Shipping/label: `tracking_number`, `shipping_service`, `label_status`, `label_storage_bucket`, `label_file_path`, `label_uploaded_at`, `label_metadata`.
- Money: `shipping_and_handling`, `seller_collected_tax`, `ebay_collected_tax`, `ebay_collected_charges`, `total_price`, `net_payout`.
- Audit/import: `raw_payload`, `imported_by`, `imported_at`, `updated_at`.

Keys/indexes/security:

- PK: `id`; unique: `order_number`.
- Indexes: `status, ship_by_date, paid_on_date`; label status; `ebay_shipment_id`; JSON/indexed label metadata tracking keys.
- RLS: enabled. Inventory staff can select; admins can write. Later import migrations allow active inventory staff to insert imported orders, update order status, and rollback their own CSV imports.

Reliability:

- `order_number` is the strongest order identifier.
- `tracking_number` is present only if imported/captured; label metadata may have richer tracking/barcode details.
- `buyer_email` may be masked or absent depending on eBay export/source.

### `public.ebay_order_lines`

Migration: `supabase/migrations/20260515090000_ebay_pending_orders_worker_checkout.sql`

Purpose: eBay order line items; each line can be fulfilled by linking to internal inventory and sales records.

Important columns:

- Identifiers: `id`, `order_id`, `item_number`, `transaction_id`, `custom_label`.
- Listing/item text: `item_title`.
- Quantities/status: `quantity`, `fulfilled_quantity`, `line_status`.
- Money: `sold_for`, `shipping_and_handling`, `total_price`, `net_payout`.
- Internal links: `internal_item_id`, `stock_location_row_id`, `location_id`, `sale_id`, `sale_item_id`, `stock_transaction_id`.
- Fulfillment audit: `fulfilled_by`, `fulfilled_by_email`, `fulfilled_at`, `notes`, `raw_payload`.

Keys/indexes/security:

- PK: `id`.
- FK: `order_id -> ebay_orders`; `internal_item_id -> item_types`; `stock_location_row_id -> item_stock_locations`; `location_id -> locations`; `sale_id -> sales`; `sale_item_id -> sale_items`; `stock_transaction_id -> stock_transactions`.
- Unique: `(order_id, item_number, transaction_id)`.
- Indexes: line status; custom label where present.
- RLS: inventory staff select; admins write; later import policy allows inventory staff to insert lines for imported orders.

Reliability:

- `item_number + transaction_id` is the strongest line match.
- `item_number` alone can be ambiguous across orders.
- `item_title` is useful as display context, but should not be treated as definitive product taxonomy.
- `internal_item_id` is reliable only after worker fulfillment linked the line to internal inventory; it can be null for no-inventory closeouts and pending lines.

### Internal Inventory / Sales Tables

Migration: `supabase/migrations/20260124184912_remote_schema.sql`

Tables:

- `item_types`: internal item catalog. Important fields include `id`, `title`, `description`, `barcode`, `qr_code`, `categories`, `photos`, `sale_price`, stock-related fields.
- `item_stock_locations`: inventory placement/quantity by `item_id` and `location_id`.
- `sales`: platform sale header; eBay fulfillment uses `platform = 'ebay'` and `external_sales_id = ebay_orders.order_number`.
- `sale_items`: sale line rows linked to `sales` and `item_types`.
- `stock_transactions`: inventory movements, including eBay checkout and return restock.
- `storefront_listings`: storefront publication metadata for internal items, not a canonical eBay listing table.

Reliability:

- `item_types.title`, `barcode`, and `qr_code` are reliable internal identifiers/descriptors when `internal_item_id` exists.
- `item_types.categories` may help internally, but should not be over-stated to buyers unless verified.
- There is no dedicated `ebay_listings` table. eBay listing context is mostly `ebay_order_lines.item_number`, `item_title`, `custom_label`, and raw payloads.

### Order Admin / Fulfillment Audit Tables

`ebay_order_admin_events`

- Migration: `20260515124500_admin_ebay_order_closeout.sql`; extended by no-inventory/cancellation migrations.
- Purpose: signed audit for `fulfilled_no_inventory` and `cancelled`.
- Important fields: `action`, `order_ids`, `order_line_ids`, `notes`, `signed_by_email`, `checkout_store_id`, GPS/evidence fields from later migrations, `payload`.
- Useful context: why an order/line was closed or cancelled without normal inventory removal.

`ebay_order_revert_events`

- Migration: `20260515133000_admin_ebay_order_reverts.sql`.
- Purpose: admin-only reversal audit for completed eBay lines.

`ebay_order_label_events`

- Migration: `20260518184500_ebay_label_attachment_audit.sql`; extended by `20260519113000_ebay_label_tracking_metadata_indexes.sql` and `20260519133000_extra_ebay_shipping_labels.sql`.
- Purpose: immutable audit for shipping label attachment, replacement, tracking backfill, and extra labels.
- Important fields: `order_ids`, `order_line_ids`, `order_numbers`, `shipment_id`, `label_file_path`, `label_metadata`, `source`.
- Useful context: label exists, tracking metadata exists, extra label was needed.

## Current Return / Cancellation / Refund Schema Map

### `public.ebay_return_cases`

Migration: `20260521123000_ebay_returns_workflow.sql`; extended by `20260521190000_unmatched_ebay_returns.sql`.

Purpose: return/refund case header.

Important columns:

- Identifiers: `id`, `order_id`, `order_number`, `case_type`, `ebay_return_id`.
- Buyer: `buyer_username`.
- Return details: `return_reason`, `return_tracking_number`, `status`.
- Dates: `opened_at`, `received_at`, `closed_at`.
- Audit: `created_by`, `created_by_email`, `notes`, `raw_payload`, `updated_at`.

Workflow states:

- `status`: `open`, `received`, `partially_received`, `needs_review`, `closed`, `cancelled`.
- `case_type`: `matched_order`, `unmatched_legacy`, `refund_only`.

Linkage:

- `order_id -> ebay_orders` when matched.
- Unmatched/refund-only cases may have null `order_id` and `order_number`, with details in `raw_payload`.

### `public.ebay_return_items`

Migration: `20260521123000_ebay_returns_workflow.sql`

Purpose: item-level return intake/disposition.

Important columns:

- `return_case_id`, `order_id`, `order_line_id`.
- `internal_item_id`, `original_stock_location_row_id`, `original_location_id`.
- `item_title`, `item_number`, expected/received quantity.
- `condition_received`: `new`, `used_good`, `damaged`, `missing_parts`, `wrong_item`, `unknown`.
- `disposition`: `restock`, `quarantine`, `damaged`, `wrong_item`, `refund_only`, `missing`, `admin_review`.
- `destination_location_id`, `stock_transaction_id`, `processed_by_email`, `notes`, `metadata`.

Reliability:

- Strong for internal operational status after return intake is saved.
- Does not necessarily prove buyer-facing refund status.

### `public.ebay_return_events`

Migration: `20260521123000_ebay_returns_workflow.sql`

Purpose: append-only-ish return audit event stream.

Actions:

- `return_created`, `return_received`, `item_inspected`, `restocked`, `closed`, `cancelled`, `admin_override`.

Useful context:

- Evidence photos, signed user, notes, order line ids, return item ids, and payload snapshots.

### Return Task Queue

Tables:

- `ebay_return_tasks`
- `ebay_return_task_events`

Migration: `20260521164500_ebay_return_task_queue.sql`; dashboard/RLS extension in `20260521222000_worker_return_task_dashboard_rpc.sql`.

Purpose: operational return work queue for intake, review, questions, and follow-ups.

Important fields:

- Task linkage: `return_case_id`, `order_id`, `order_line_ids`.
- Task state: `task_type`, `status`, `priority`, `assigned_to_user_id`, `due_at`, `started_at`, `resolved_at`, `resolution_notes`.
- Metadata: `metadata` often stores parsed eBay return export details.

RPCs:

- `open_ebay_return_case(...)`
- `open_unmatched_ebay_return_case(...)`
- `assign_ebay_return_task(...)`
- `create_ebay_return_question_task(...)`
- `update_ebay_return_task_status(...)`
- `sync_ebay_return_tasks_after_intake(...)`
- `update_ebay_return_task_export_metadata(...)`
- `list_my_ebay_return_tasks(_limit)`

### `public.ebay_return_messages`

Migration: `20260521220500_ebay_return_message_logs.sql`

Purpose: lightweight audit trail for messages typed/sent through eBay return pages. It does not send messages.

Important fields:

- Linkage: `return_case_id`, `order_id`, `order_number`, `ebay_return_id`, `buyer_username`.
- Message: `direction`, `channel`, `message_status`, `message_body`, `sent_at`, `logged_at`.
- Context: `item_title`, `return_reason`, `request_amount`, `page_url`, `metadata`.

RPC:

- `record_ebay_return_message_log(_payload, _signed_by_email)`

Useful for draft context:

- Prior logged return-page messages can prevent duplicate or contradictory responses, but message status may be `sent_from_ebay_page_unverified`, so treat as audit context, not guaranteed delivery.

### Cancellation / Refund Notes

- Order cancellation is represented by `ebay_order_lines.line_status = 'cancelled'`, `ebay_orders.status = 'cancelled'` when applicable, and `ebay_order_admin_events.action = 'cancelled'`.
- Return/refund-only workflows are represented by `ebay_return_cases.case_type = 'refund_only'` or `unmatched_legacy` plus raw payload fields such as `refundText`.
- There is no canonical dedicated `refunds`, `chargebacks`, or `disputes` table found in this audit.

## Current Worker / Task Schema Map

### `public.ebay_order_tasks` / `public.ebay_order_task_events`

Migration: `20260522103000_ebay_order_coordination_tasks.sql`

Purpose: internal coordination tasks tied to eBay orders.

Important fields:

- Linkage: `order_id`, `order_line_ids`.
- State: `task_type`, `status`, `priority`, `assigned_to_user_id`, `assigned_to_role`, `due_at`.
- Work notes: `question`, `latest_note`, `latest_photo_count`, `resolution_notes`.
- Audit: events with `action`, status/assignee deltas, notes, `photo_attachments`.

RPCs:

- `list_ebay_order_task_assignees()`
- `create_ebay_order_coordination_task(...)`
- `respond_ebay_order_coordination_task(...)`
- `list_my_ebay_order_tasks(_limit)`
- `list_admin_ebay_order_tasks(_limit)`

Draft usefulness:

- Open high/urgent tasks can tell the drafter that internal review is pending.
- Do not expose internal notes verbatim to buyers without operator review.

### `public.team_tasks` / `public.team_task_events`

Migration: `20260522113000_team_independent_tasks.sql`

Purpose: general internal admin/worker tasks not necessarily tied to an eBay order.

Useful only when future matching explicitly links a task to a message/order in metadata. No direct eBay order FK exists.

## Useful RPCs / Functions

Order and fulfillment:

- `fulfill_ebay_order_line(...)`
- `fulfill_ebay_order_line_for_store(...)`
- `fulfill_ebay_order_line_with_live_lot(...)`
- `fulfill_ebay_order_line_with_live_lot_for_store(...)`
- `admin_close_ebay_order_lines(...)`
- `complete_ebay_order_lines_without_inventory_evidence(...)`
- `cancel_ebay_order_lines(...)`
- `admin_revert_ebay_order_lines(...)`

Shipping labels:

- `attach_ebay_shipping_label(...)`
- `attach_ebay_extra_shipping_label(...)`
- label metadata indexes support lookups by `trackingNumber`, `shippingBarcodeNumber`, and `labelId`.

Returns:

- `receive_ebay_return(...)`
- `open_ebay_return_case(...)`
- `open_unmatched_ebay_return_case(...)`
- `record_ebay_return_message_log(...)`
- return task RPCs listed above.

Email processing/classification:

- `supabase/functions/microsoft-email-process/index.ts`: normalizes message bodies and runs deterministic `match_order`.
- `supabase/functions/microsoft-email-classify/index.ts`: classifies messages and generates response drafts using stored email context plus compact deterministic links.

eBay API:

- `supabase/functions/ebay-feedback-sync/index.ts` uses eBay Trading API `GetFeedback` and `GetItem` for homepage testimonials. It is not an order/return/message sync.

## Email-to-eBay Matching Opportunities

Existing matching already implemented in `microsoft-email-process`:

- Extracts eBay order numbers with pattern like `00-00000-00000`.
- Extracts 12-digit item numbers and 14-digit transaction IDs.
- Extracts `#123` style labels.
- Extracts buyer username from subjects like "`buyer` sent a message".
- Extracts participant emails.
- Writes to `email_message_links`.

High-confidence matches:

- Exact `ebay_orders.order_number` in subject/body: `confidence = 1.0`, confirmed.
- Exact `ebay_order_lines.item_number + transaction_id`: `confidence = 1.0`, confirmed.
- Exact `ebay_return_cases.ebay_return_id` when a return id is present.
- Exact label metadata tracking number or shipping barcode once added to matching.

Medium-confidence matches:

- Unique `ebay_order_lines.item_number`: current `confidence = 0.8`, suggested.
- Unique `ebay_order_lines.custom_label`: current `confidence = 0.7`, suggested.
- Unique internal `item_types.barcode` or `qr_code`: current `confidence = 0.65`, suggested.
- Buyer username plus another strong clue such as order number, item number, or label: current `confidence = 0.6`, suggested.

Low-confidence matches:

- Unique line title contains label/text: current `confidence = 0.55`, suggested.
- Unique internal item title contains label/text: current `confidence = 0.5`, suggested.
- Buyer username alone, especially for repeat buyers or old orders.
- Buyer email alone if masked, forwarded, or platform-proxied.

Unsafe/unreliable matches:

- Generic item title words like watch, ring, bracelet, chain, pendant.
- `item_number` alone when multiple order lines share it.
- Buyer display name or recipient name alone.
- Email category alone, such as `return_request`, without an order/return identifier.
- Raw eBay page snapshots without persisted order/line confirmation.

## Safe AI Draft Context Fields

Safe to inject when explicitly present in DB:

- Order: `order_number`, `sale_date`, `paid_on_date`, `ship_by_date`, `shipped_on_date`, `status`.
- Shipping: `tracking_number`, `shipping_service`, `label_status`, selected safe fields from `label_metadata` such as tracking number, shipping barcode, label id.
- Buyer: `buyer_username` as a platform username; avoid over-personalizing with `buyer_name` unless needed.
- Line: `item_number`, `transaction_id`, `item_title`, quantity, line status.
- Internal item: `item_types.title`, `barcode`, `qr_code`, categories only when line has `internal_item_id`.
- Return: `ebay_return_id`, `return_reason`, `return_tracking_number`, `status`, `case_type`, opened/received/closed dates.
- Return item: received quantity, condition received, disposition, processed date.
- Tasks: existence/status/priority of open order or return tasks; summarize as "internal review is pending" rather than quoting raw task text.
- Prior eBay return messages: direction/status/date and safe summarized content, with status caveats.

Use cautiously:

- `buyer_email`: may be masked/proxied; useful for matching more than prose.
- `item_title`: eBay listing title can be buyer-visible but may be generic or outdated.
- `item_types.description` and `categories`: internal catalog data may not match the exact sold eBay listing.
- `raw_payload`: useful only after whitelisting known keys.
- `net_payout`, taxes, platform fees: internal-only; do not include in buyer drafts.
- Evidence photos, GPS, employee emails, internal notes: internal-only.

Forbidden unless verified and explicitly present:

- Delivery promises or exact ETAs.
- Refund approval/issuance.
- Return approval.
- Replacement availability.
- Authenticity/condition conclusions.
- Legal admissions or fault.
- Any item/order details not present in the enriched DB context.

## Unsafe / Missing / Incomplete Data

Missing or incomplete:

- No canonical `customers` table.
- No canonical `ebay_listings` table.
- No canonical refunds/chargebacks/disputes table.
- No direct eBay Messages API ingestion.
- No current rich context builder for draft generation.
- Current `email_message_links` stores compact links but not full context snapshots.
- Current draft generator sees `has_ebay_order` and matched values, not order dates, shipping status, return state, or item facts.

Unreliable:

- `buyer_email` may be masked.
- `item_number` alone may not identify a unique current order line.
- `item_title` does not prove internal item type or condition.
- Unmatched return raw payloads can contain useful item/return text but should be treated as unverified imported page data.

## Recommended Step 4D.1 Implementation Plan

Best deterministic email-to-order matching layer:

- Build on existing `microsoft-email-process` `match_order`.
- Keep writing to `email_message_links`; it is already the right linking table and supports `suggested`, `confirmed`, `rejected`, and `stale`.
- Add manual review controls in the operator UI before any low/medium match is treated as authoritative.

Tables to read:

- Email: `email_messages`, `email_message_bodies`, `email_message_recipients`, `email_message_links`.
- Orders: `ebay_orders`, `ebay_order_lines`.
- Returns: `ebay_return_cases`, `ebay_return_items`, `ebay_return_messages`.
- Inventory: `item_types`, `item_stock_locations`.
- Optional task context: `ebay_order_tasks`, `ebay_return_tasks`.

Columns to match:

- `ebay_orders.order_number`.
- `ebay_order_lines.item_number`, `transaction_id`, `custom_label`.
- `ebay_orders.buyer_username`, `buyer_email`.
- `ebay_return_cases.ebay_return_id`, `order_number`, `buyer_username`.
- `ebay_return_messages.ebay_return_id`, `order_number`.
- `ebay_orders.tracking_number`, `label_metadata->>'trackingNumber'`, `label_metadata->>'shippingBarcodeNumber'`.
- `item_types.barcode`, `qr_code`.

Confidence approach:

- `1.00`: exact order number; exact item+transaction; exact return id.
- `0.85-0.95`: exact tracking/label id with unique order.
- `0.75-0.85`: unique item number or custom label.
- `0.60-0.70`: buyer username/email with another strong clue.
- `0.40-0.60`: title/name contains matches, unique only, always suggested.
- Below `0.60`: never auto-confirm.

Recommendation:

- A new linking table is not needed now. `email_message_links` already exists and has the right status lifecycle.
- Add richer match metadata and possibly a read-only view/RPC for "current best link per message".
- Matching should be manual-reviewable, especially for returns/refunds/cancellations and any item-title-only match.

## Recommended Step 4D.2 Draft Context Plan

Best enrichment approach:

- Add a server-side, read-only "email draft context" builder after matching and before `generate_response`.
- It should load only confirmed links plus high-confidence suggested links when explicitly allowed.
- It should return a structured, whitelisted context object with `known`, `unknown`, and `do_not_claim` sections.

Context to inject:

- Confirmed order header facts.
- Confirmed line facts.
- Shipping/label facts when present.
- Return case/task/message summaries when present.
- Internal task status only as operational context.
- Explicit unknowns such as "tracking number not found in DB" or "no return case found".

Forbidden:

- Do not inject raw payloads wholesale.
- Do not inject internal costs, payouts, employee notes, GPS, evidence paths, or private emails into buyer-facing prose.
- Do not let the model turn missing fields into claims.

Hallucination prevention:

- Keep the existing draft prompt rule: use only supplied context.
- Extend validation to compare draft claims against enriched order context, not only email text/deterministic links.
- Require `requires_human_review = true` for all drafts.
- Add safety flags for unsupported order, shipping, refund, and item claims.

Missing/unknown item data:

- Surface as explicit unknowns to the operator.
- In drafts, use neutral language like "we are reviewing the order details" instead of naming item type when the DB does not support it.

## Recommended Step 4D.3 eBay Developer API Evaluation Plan

Recommendation:

- Keep Outlook as the primary message ingestion source for now.
- Add eBay API later mainly for authoritative order, return, refund, shipping, and message context.

Why Outlook should remain primary:

- The current triage pipeline is built around Outlook mailbox ingestion, persistence, classification, review, and draft generation.
- Operators already need email-wide triage, not only eBay messages.
- Outlook captures non-eBay customer/internal/vendor communications.

Where eBay API can help later:

- Authoritative order detail/status.
- Fulfillment/shipping/tracking details.
- Return/refund status.
- Buyer messages and case/dispute context if available through current eBay APIs.
- Listing metadata and item specifics.

Evaluate later:

- Fulfillment API orders.
- Sell Returns / Post-Order return capabilities.
- Sell Feed or report APIs for order import replacement.
- Messaging/member message APIs if supported for the seller account and use case.
- OAuth/token storage, rate limits, data retention, and eBay policy constraints.

## Risks / Open Questions

- Are eBay order report CSV fields stable enough to rely on `buyer_email`, `item_title`, and `custom_label`?
- Should suggested links ever be used for draft context, or only confirmed links?
- How should operators confirm/reject links in the UI?
- Which `label_metadata` keys are guaranteed by the browser extension?
- Can eBay API provide enough message/return data to reduce reliance on page-scraped extension payloads?
- Should return/refund decisions be represented in a dedicated future refund/dispute table?
- Should `email_message_links.link_type` gain `ebay_return_case` in a future migration, or should return context hang off matched orders for now?

## Verification

Files/areas inspected:

- `supabase/migrations/`
- `supabase/functions/`
- `pending-orders.js`
- `ebay-order-history.js`
- `worker-dashboard.js`
- `email-triage.js`
- `tools/ebay-og-order-link-extension/`
- `ebayExport.js`
- `ebayExportbracelet.js`
- existing `docs/email-triage/` planning/audit docs

Files created/modified:

- Created `docs/email-triage/STEP_4D_EBAY_ORDER_CONTEXT_AUDIT.md`

Main schema findings:

- Core order data: `ebay_orders`, `ebay_order_lines`.
- Buyer data: `buyer_username`, `buyer_name`, `buyer_email` on `ebay_orders`; no canonical customer table.
- Item data: `ebay_order_lines` plus internal `item_types`; no canonical eBay listings table.
- Return data: `ebay_return_cases`, `ebay_return_items`, `ebay_return_events`, `ebay_return_tasks`, `ebay_return_messages`.
- Worker coordination: `ebay_order_tasks`, `ebay_return_tasks`, `team_tasks`.

Main matching recommendations:

- Extend existing `email_message_links` matching rather than creating a parallel link system.
- Treat exact order number, item+transaction, return id, and tracking matches as high confidence.
- Keep item-title, buyer-only, and generic category matches as suggested/manual-review only.

Main AI draft-context recommendations:

- Add a whitelisted context builder before draft generation.
- Inject only explicit DB facts.
- Preserve human review for every draft.
- Validate drafts against enriched context to catch fabricated order/shipping/refund/item claims.

Confirmation:

- No code, schema, backend behavior, UI behavior, prompts, matching logic, eBay API integration, sync jobs, or sending behavior were changed.
