# Step 4F Post-Merge eBay Data Audit

Audit date: 2026-05-25  
Scope: read-only post-merge audit of newly available eBay/order/task data for Email Triage deterministic matching, classification context, and draft generation.  
Branch observed: `Email_Assistant_PM`

## A. Executive Summary

The merged repo now has enough eBay/order/return/buyer/task infrastructure for Email Triage to reuse local Supabase data instead of building a separate Email-specific direct eBay API enrichment path.

High-value eBay data now available locally includes:

- Current and historical eBay orders in `ebay_orders`.
- Order lines, eBay item/listing identifiers, transaction IDs, item titles, quantities, SKUs/custom labels, internal item links, and fulfillment state in `ebay_order_lines`.
- Buyer username, buyer name, buyer email, order dates, payment dates, ship-by dates, shipped dates, order status, and raw eBay payloads on `ebay_orders`.
- Return/refund cases in `ebay_return_cases`, return items in `ebay_return_items`, return task state in `ebay_return_tasks`, return events in `ebay_return_events`, and prior return-page/API messages in `ebay_return_messages`.
- Shipping label/tracking metadata in `ebay_orders.label_metadata`, `ebay_orders.tracking_number`, `ebay_orders.shipping_service`, and `ebay_order_label_events`.
- Order and return operational task state in `ebay_order_tasks`, `ebay_order_task_events`, `ebay_return_tasks`, and `ebay_return_task_events`.
- Buyer/account history sync metadata in `ebay_buyer_history_syncs` and `ebay_account_history_sync_runs`.
- Buyer-level summary RPCs: `list_ebay_buyer_profitability` and `get_ebay_buyer_insights`.

Email Triage can reuse this data through the existing `email_message_links` matching table and the existing verified draft context path in `microsoft-email-classify`.

Main conclusion:

Use existing synced eBay tables first. Do not build a competing direct eBay API enrichment path inside Email Triage yet. If data is stale or missing, add an operator-gated refresh path that invokes existing sync functions, not a new Email-specific eBay API client.

Limitation:

The local Supabase runtime could not be inspected because Docker was not running. `npx supabase status` failed with:

```text
Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?
```

Therefore this audit confirms schema/function/code availability from repo files, not live row counts.

## B. New eBay Infrastructure Inventory

### Core Order Tables

| Object | Type | Purpose | Useful for Email Triage? | Notes |
|---|---|---|---|---|
| `ebay_orders` | Table | eBay order header: order number, buyer, dates, status, totals, raw payload | Yes | Strongest order-level source. Created in `20260515090000_ebay_pending_orders_worker_checkout.sql`. |
| `ebay_order_lines` | Table | eBay line items: item number, transaction ID, item title, custom label/SKU, internal item/sale links | Yes | Strongest line-level source. `item_number + transaction_id` is high confidence. |
| `ebay_order_line_reservations` | Table | Reserved stock for imported paid eBay orders | Maybe | Useful for internal operational context, not buyer-facing draft claims. |
| `active_stock_reservations` | View | Combined live-sale and eBay reserved stock view | Low | Inventory availability context only. |
| `ebay_order_sync_runs` | Table | Audit of order sync runs | Yes | Useful staleness/coverage signal. |

### Shipping / Label Infrastructure

| Object | Type | Purpose | Useful for Email Triage? | Notes |
|---|---|---|---|---|
| `ebay_orders.tracking_number` | Column | Stored tracking number when available | Yes | Can power tracking exact match and verified draft context. |
| `ebay_orders.shipping_service` | Column | Shipping service/carrier-ish label | Yes | Safe only when present. |
| `ebay_orders.ebay_shipment_id` | Column | eBay shipment identifier | Maybe | Useful for label/shipment disambiguation. |
| `ebay_orders.label_status` | Column | Label workflow status | Yes | Internal status; avoid overstating to buyer. |
| `ebay_orders.label_metadata` | JSONB column | Label metadata including tracking/barcode/label IDs | Yes | Existing classifier only exposes safe keys. |
| `ebay_order_label_events` | Table | Immutable-ish label attach/replacement/tracking audit | Yes | Useful evidence for tracking/label messages. |
| `attach_ebay_shipping_label` | RPC | Attach label and write audit event | No direct matching | Existing operational path; Email Triage should not call for matching. |
| `backfill_ebay_label_tracking_metadata` | RPC | Add tracking metadata to labels/orders | No direct matching | Operational/admin-only behavior. |

### Return / Refund Infrastructure

| Object | Type | Purpose | Useful for Email Triage? | Notes |
|---|---|---|---|---|
| `ebay_return_cases` | Table | Return/refund case header | Yes | Return ID, buyer, reason, status, order link. |
| `ebay_return_items` | Table | Returned item intake/disposition | Yes, cautious | Internal facts; do not infer refund approval. |
| `ebay_return_events` | Table | Return audit events | Maybe | Rich internal context; avoid exposing evidence/notes. |
| `ebay_return_tasks` | Table | Return work queue | Yes | Helpful for review/draft state. |
| `ebay_return_task_events` | Table | Return task history | Maybe | Internal only. |
| `ebay_return_messages` | Table | Logged eBay return-page/API messages | Yes | Prior buyer/seller message context. |
| `ebay_return_sync_runs` | Table | Return sync audit | Yes | Staleness/coverage signal. |
| `open_ebay_return_case` | RPC | Create/adopt matched return case and task | No direct matching | Existing workflow; should not be called by email matching automatically. |
| `open_unmatched_ebay_return_case` | RPC | Create unmatched return review case/task | No direct matching | Useful existing workflow, not automatic email mutation. |
| `record_ebay_return_message_log` | RPC | Record return-page message log | Maybe | Existing message audit path. |

### Order Task / Operational Workflow

| Object | Type | Purpose | Useful for Email Triage? | Notes |
|---|---|---|---|---|
| `ebay_order_tasks` | Table | Order coordination, shipping prep, packaging, admin review | Yes | Great internal state before drafting/sending. |
| `ebay_order_task_events` | Table | Task event history | Maybe | Internal evidence, avoid exposing notes. |
| `create_ebay_order_coordination_task` | RPC | Create order task | No direct matching | Existing operational mutation; do not call automatically. |
| `respond_ebay_order_coordination_task` | RPC | Task status/comment updates | No direct matching | Existing workflow. |
| `assign_ebay_order_shipping_task` | RPC | Assign shipping task | No direct matching | Existing workflow. |
| `handoff_ebay_order_shipping_task` | RPC | Shipping/packaging handoff | Maybe | Context only if already present. |
| `list_my_ebay_order_tasks` | RPC | Worker task dashboard | Low | UI/dashboard, not matching. |
| `list_admin_ebay_order_tasks` | RPC | Admin task dashboard | Low | UI/dashboard, not matching. |

### Inventory / Listing / SKU Infrastructure

| Object | Type | Purpose | Useful for Email Triage? | Notes |
|---|---|---|---|---|
| `ebay_inventory_links` | Table | Internal item to eBay SKU/offer/listing link | Yes | Valuable bridge from email SKU/listing hints to inventory/order lines. |
| `ebay_inventory_settings` | Table | eBay marketplace/policy/config | Low | Mostly publishing config. |
| `ebay_inventory_sync_runs` | Table | Inventory sync audit | Maybe | Staleness/readiness signal for listing data. |
| `mark_ebay_item_dirty` | RPC | Mark item for inventory sync | No | Do not call from Email Triage matching. |
| `get_ebay_sync_candidate_item_ids` | RPC | Find items needing inventory sync | No direct matching | Inventory sync workflow only. |

### Buyer / Account History

| Object | Type | Purpose | Useful for Email Triage? | Notes |
|---|---|---|---|---|
| `ebay_buyer_history_syncs` | Table | Per-buyer deep history sync metadata | Yes | Tells whether buyer history is fresh/missing. |
| `ebay_account_history_sync_runs` | Table | Account-wide eBay order archive sync runs | Yes | Coverage/staleness signal. |
| `list_ebay_buyer_profitability` | RPC | Buyer order/return/profitability summary | Maybe | Internal prioritization only. Do not use buyer-facing. |
| `get_ebay_buyer_insights` | RPC | Buyer summary, recent orders, top items, recent returns | Yes | Useful operator context and possible match disambiguation. |

### Compliance / Feedback

| Object | Type | Purpose | Useful for Email Triage? | Notes |
|---|---|---|---|---|
| `ebay_account_deletion_notifications` | Table | eBay account deletion notification log | Low | Privacy/compliance only. |
| `ebay_reviews`, `ebay_review_sync_runs` | Tables | Storefront testimonials/reviews | Low | Not relevant for email matching. |

## C. Edge Function Audit

| Function | What it syncs | Source API | Target tables | Can Email Triage reuse this? |
|---|---|---|---|---|
| `ebay-order-sync` | Paid awaiting-shipment orders and lines | eBay Sell Fulfillment API | `ebay_orders`, `ebay_order_lines`, `ebay_order_sync_runs`, `ebay_order_line_reservations` | Yes. Primary current-order source. |
| `ebay-return-sync` | Return summaries/details/files/messages | eBay Post-Order Return API | `ebay_return_cases`, `ebay_return_items`, `ebay_return_tasks`, `ebay_return_messages`, `ebay_return_sync_runs` | Yes. Primary return/refund context source. |
| `ebay-buyer-history-sync` | Buyer-specific and account-wide historical orders | eBay Sell Fulfillment API | `ebay_orders`, `ebay_order_lines`, `ebay_buyer_history_syncs`, `ebay_account_history_sync_runs` | Yes. Best source for old buyer/order context. |
| `ebay-inventory-sync` | Internal inventory to eBay inventory/offers/listings | eBay Sell Inventory API | `ebay_inventory_links`, `ebay_inventory_sync_runs`, public eBay photo storage | Yes for SKU/listing lookup, not for email-triggered publishing. |
| `ebay-publishing-setup` | Payment/return/fulfillment policies and locations | eBay Account API, Inventory API | `ebay_inventory_settings` | No direct triage use. |
| `ebay-oauth-callback` | OAuth code exchange helper | eBay OAuth | No durable order data | No direct triage use. |
| `ebay-feedback-sync` | eBay feedback/testimonial import | eBay Trading API | `customer_testimonials` | Low triage value. |
| `sync-ebay-feedback` | Redirect/instruction wrapper for feedback sync | N/A | N/A | No. |
| `ebay-account-deletion` | Account deletion notifications | eBay notification webhook | `ebay_account_deletion_notifications` | Compliance only. |

## D. Current Email Matching Layer Summary

Current deterministic processing is in `supabase/functions/microsoft-email-process/index.ts`.

The processor supports:

- Normalization job: writes normalized body text into `email_message_bodies`.
- Match job: extracts identifiers and writes `email_message_links`.

Current extracted identifiers:

- eBay order numbers: `NN-NNNNN-NNNNN`.
- Item numbers: 12-digit IDs.
- Transaction IDs: 14-digit IDs.
- Listing/internal labels: `#123`, `custom label`, `sku`, or `label` patterns.
- Return IDs.
- Tracking/label IDs.
- Title phrases from subject/body.
- Buyer usernames from subject patterns and sender display names.
- Buyer emails from participants/body, with eBay relay/no-reply masking guarded.

Current queried local tables:

- `ebay_orders`.
- `ebay_order_lines`.
- `ebay_return_cases`.
- `item_types`.
- `email_message_links`.

Current deterministic links:

- `ebay_order`.
- `ebay_order_line`.
- `inventory_item`.
- `sale`.
- `customer_identity` is allowed by schema but not meaningfully populated in the audited code.

Existing strengths:

- Exact order number is confirmed.
- Return ID linked to an order is confirmed.
- Item number plus transaction ID is confirmed.
- Tracking/label exact match is confirmed when unique.
- SKU/custom label can create suggested line/item links.

Existing weaknesses:

- Buyer username alone remains weak and can create ambiguity.
- Item number alone can match multiple historical order lines.
- Title phrase matching is fuzzy and should stay suggested.
- Existing matching does not yet use `ebay_buyer_history_syncs`, `ebay_account_history_sync_runs`, `ebay_order_label_events`, `ebay_inventory_links.listing_id`, or `get_ebay_buyer_insights`.
- Existing matching does not yet record lookup attempts/staleness independently.

| Current Matching Input | Current Source | Weakness | Possible New eBay Source |
|---|---|---|---|
| Order number | Subject/body | Only works when present | `ebay_orders.order_number` |
| Return ID | Subject/body | Only useful after return sync | `ebay_return_cases.ebay_return_id` |
| Item number + transaction ID | Subject/body | Strong but not always present | `ebay_order_lines.item_number`, `transaction_id` |
| Item number alone | Subject/body | Ambiguous across history | Add buyer/date/order proximity using `ebay_orders` |
| SKU/custom label | Subject/body | Can collide or be internal-only | `ebay_order_lines.custom_label`, `ebay_inventory_links.sku`, `item_types.barcode` |
| Listing ID | Currently item-number-like only | Listing/offer link not fully used | `ebay_inventory_links.listing_id`, `ebay_order_lines.item_number` |
| Tracking number | Subject/body | Current lookup misses label event table | `ebay_orders.tracking_number`, `label_metadata`, `ebay_order_label_events.label_metadata` |
| Buyer username | Subject/from name | Weak alone | `ebay_orders.buyer_username`, `get_ebay_buyer_insights`, buyer history metadata |
| Buyer email | Participants/body | Often masked by eBay | `ebay_orders.buyer_email`, with relay/no-reply filtering |
| Title phrase | Subject/body | Fuzzy and unsafe alone | `ebay_order_lines.item_title`, but suggested only |

## E. Classification And Draft Context Summary

Current classification and draft generation are in `supabase/functions/microsoft-email-classify/index.ts`.

Classification input currently receives:

- Message metadata.
- Participants.
- Truncated body text.
- Compact deterministic link summaries.

Draft generation already has a stronger verified context builder:

- `adminContextView` reads `email_message_links`.
- It loads linked `ebay_orders`, `ebay_order_lines`, `ebay_return_cases`, `ebay_return_items`, `ebay_return_tasks`, `ebay_order_tasks`, and `ebay_return_messages`.
- `buildVerifiedOrderContext` filters buyer-facing facts to confirmed, non-weak matches.
- Weak/suggested/title/buyer-only/internal-label matches are treated as unverified for buyer-facing drafts.

This is a good safety foundation. The main missing piece is improving link creation before classification/drafting.

## F. Best eBay Data Sources For Email Triage

| Field | Table/Column | Email Matching Use | Draft Generation Use | Safety Concern |
|---|---|---|---|---|
| eBay order ID | `ebay_orders.order_number` | Confirmed order match | Can mention if confirmed | Low risk if exact. |
| Sales record number | `ebay_orders.sales_record_number` | Secondary order clue | Internal only | Not always present. |
| Buyer username | `ebay_orders.buyer_username` | Disambiguation | Personalization if verified | Weak alone. |
| Buyer full name | `ebay_orders.buyer_name` | Disambiguation | Greeting/context if verified | PII; minimize exposure. |
| Buyer email | `ebay_orders.buyer_email` | Disambiguation | Usually not buyer-facing | eBay relay/no-reply can mislead. |
| Item/listing ID | `ebay_order_lines.item_number` | Order-line match | Item identity if verified | Ambiguous alone. |
| Transaction ID | `ebay_order_lines.transaction_id` | Strong with item number | Internal confidence | Do not overexpose. |
| SKU/custom label | `ebay_order_lines.custom_label` | Match internal labels/SKUs | Internal item bridge | Not buyer-facing by default. |
| Listing ID | `ebay_inventory_links.listing_id` | Match listing URLs/IDs | Internal context | May not prove purchase/order. |
| Offer ID | `ebay_inventory_links.offer_id` | Listing/inventory bridge | Internal only | Not buyer-facing. |
| Item title | `ebay_order_lines.item_title` | Fuzzy clue | Can mention if verified match | Avoid title-only confirmation. |
| Internal item | `ebay_order_lines.internal_item_id`, `item_types` | Inventory bridge | Internal item facts | Avoid promising availability. |
| Fulfillment status | `ebay_orders.status`, `ebay_order_lines.line_status` | Triage/action | Can support careful status language | Local status may lag eBay. |
| Payment status | Raw eBay payload keys | Classification signal | Usually internal | Avoid saying payment/refund processed unless verified. |
| Tracking number | `ebay_orders.tracking_number`, `label_metadata.trackingNumber` | Shipping email match | Can mention exact tracking if verified | Do not infer carrier movement/delivery. |
| Carrier/service | `ebay_orders.shipping_service` | Shipping context | Can mention if verified | May be label service, not live carrier state. |
| Return case ID | `ebay_return_cases.ebay_return_id` | Confirmed return match | Can mention if confirmed | Return status is not refund approval. |
| Return reason | `ebay_return_cases.return_reason` | Classification signal | Careful acknowledgement | Buyer stated reason may not be verified defect. |
| Return tracking | `ebay_return_cases.return_tracking_number` | Return shipping context | Can mention if verified | Do not infer receipt unless `received_at` present. |
| Return messages | `ebay_return_messages.message_body` | Conversation context | Draft continuity | Summarize; avoid exposing internal/private text. |
| Task status | `ebay_order_tasks`, `ebay_return_tasks` | Operational state | Internal safe wording | Do not expose staff notes. |
| Sync metadata | `ebay_order_sync_runs`, `ebay_return_sync_runs`, `ebay_buyer_history_syncs`, `ebay_account_history_sync_runs` | Staleness and confidence | Internal only | Avoid stale claims. |
| Raw payloads | `raw_payload` columns | Backstop details | Use only via curated fields | PII and oversized/private data risk. |

## G. Recommendation On eBay API Enrichment

Recommended option:

```text
A. Query existing eBay tables only
D. Create a safe Email-specific cache/audit table only if repeated ambiguity/staleness tracking requires it
B. Trigger existing eBay sync functions only through an operator-gated stale/missing-data action
```

Do not choose C yet:

```text
C. Build a new Email-specific eBay API enrichment path
```

Reasons:

- The repo already has maintained eBay sync functions for orders, returns, inventory, and buyer/account history.
- A second Email-specific eBay API client would duplicate token handling, rate limit behavior, API mapping, raw payload policy, and error handling.
- Existing synced tables already match the Email Triage need: deterministic matching and safe context.
- Email Triage should not mutate production order/inventory/return tables except through existing intended operational flows.

When data is stale/missing:

- Show an operator-visible "context may be stale" state.
- Offer a manual/admin "refresh eBay context" action later.
- That action should invoke existing `ebay-order-sync`, `ebay-return-sync`, or `ebay-buyer-history-sync` with explicit scope and dry-run/review behavior where possible.

## H. Suggested Integration Design

Recommended flow:

```text
Email imported
-> normalize body
-> extract identifiers
-> current deterministic matching
-> additional read-only eBay context lookup
-> create/update email_message_links only
-> classify with deterministic link summary
-> build verified order context for draft generation
-> draft with confirmed context only
-> human review before sending
```

Incremental implementation plan:

1. Add read-only lookup expansion inside `microsoft-email-process`:
   - Use `ebay_inventory_links` for SKU/listing bridges.
   - Use `ebay_order_label_events` for tracking/label matches.
   - Use `ebay_buyer_history_syncs` and `ebay_account_history_sync_runs` as staleness metadata.
   - Use `ebay_return_cases` by order number + buyer + item where return ID is absent.

2. Tighten confidence rules:
   - Confirmed: exact order number, exact return ID with linked order, item number + transaction ID, unique tracking/label match.
   - Suggested: item number alone, SKU/custom label alone, buyer username plus context.
   - Weak: buyer username alone, title phrase alone, inventory title contains.

3. Add link metadata:
   - `data_sources_checked`.
   - `sync_freshness`.
   - `ambiguity`.
   - `stale_context_warning`.
   - `matched_fields`.

4. Keep existing `email_message_links` as the primary link table.

5. Consider a lightweight table only after first pass:

```text
email_ebay_lookup_attempts
```

Possible purpose:

- Record identifiers extracted.
- Record data sources checked.
- Record stale/missing status.
- Record ambiguity counts.
- Avoid writing lookup diagnostics into production order tables.

Avoid creating `email_order_context_snapshots` unless draft reproducibility requires immutable context snapshots. The existing draft metadata already stores some context summary, and copying too much eBay data creates privacy/staleness risk.

## I. Sending Roadmap Impact

Recommended roadmap:

```text
4F.4 eBay Context Audit / Matching Integration
4F.5 Classification Review Refinement
4F.6 Draft Queue Refinement
4F.7 Send Approved Drafts
4F.8 Reply/Thread Tracking
```

Rationale:

- The audit confirms eBay enrichment should happen before sending.
- The next work should be matching/context integration, not a new API path.
- Classification review should happen after context improves, because better links will change AI inputs and review needs.
- Draft queue refinement should happen after context and classification are stable.
- Sending should stay blocked until match confidence, context freshness, and draft review behavior are reliable.

## J. Safety Notes

Stale data:

- eBay order/return status may lag live eBay.
- Use sync metadata as a visible confidence signal.
- Never phrase stale local data as live eBay truth.

Duplicate sync paths:

- Avoid building an Email-specific direct eBay API path.
- Reuse existing eBay sync functions if refresh is needed.

Production table writes:

- Email matching should write to `email_message_links` and possibly Email-specific audit/cache tables only.
- Do not write to `ebay_orders`, `ebay_order_lines`, `ebay_return_cases`, inventory, or task tables during passive matching.

Privacy:

- Raw eBay payloads may contain PII, shipping addresses, phone data, buyer details, and internal metadata.
- Do not pass raw payloads directly to AI.
- Continue using curated safe fields.

AI hallucination prevention:

- Keep the existing `verified_order_context` guard.
- Treat weak/suggested matches as generic for buyer-facing drafts.
- Do not let the model claim shipment movement, delivery, refund approval, return approval, replacement availability, exact timelines, authenticity, or defect cause unless explicit verified facts exist.

Buyer profitability:

- `list_ebay_buyer_profitability` and `get_ebay_buyer_insights` can help internal triage priority.
- Do not let profitability affect buyer-facing language or service commitments.

Return status:

- Return case existence is not refund approval.
- Return reason is often buyer-stated, not verified item condition.
- Return task state is internal workflow state, not buyer-facing status unless intentionally translated.

## K. Source Files Reviewed

Primary migrations:

- `supabase/migrations/20260515090000_ebay_pending_orders_worker_checkout.sql`
- `supabase/migrations/20260518165000_ebay_shipping_label_attachments.sql`
- `supabase/migrations/20260518184500_ebay_label_attachment_audit.sql`
- `supabase/migrations/20260519113000_ebay_label_tracking_metadata_indexes.sql`
- `supabase/migrations/20260519114500_backfill_ebay_label_tracking_metadata.sql`
- `supabase/migrations/20260521123000_ebay_returns_workflow.sql`
- `supabase/migrations/20260521164500_ebay_return_task_queue.sql`
- `supabase/migrations/20260521220500_ebay_return_message_logs.sql`
- `supabase/migrations/20260522103000_ebay_order_coordination_tasks.sql`
- `supabase/migrations/20260522143000_ebay_inventory_sync.sql`
- `supabase/migrations/20260523233000_ebay_order_sync_reservations.sql`
- `supabase/migrations/20260524103000_ebay_return_api_sync.sql`
- `supabase/migrations/20260524123000_email_triage_live_sync_toggle.sql`
- `supabase/migrations/20260524124500_email_triage_run_live_refresh_event.sql`
- `supabase/migrations/20260524173000_ebay_account_history_sync_runs.sql`
- `supabase/migrations/20260524173500_ebay_buyer_history_sync_metadata.sql`

Primary Edge Functions:

- `supabase/functions/ebay-order-sync/index.ts`
- `supabase/functions/ebay-return-sync/index.ts`
- `supabase/functions/ebay-buyer-history-sync/index.ts`
- `supabase/functions/ebay-inventory-sync/index.ts`
- `supabase/functions/ebay-publishing-setup/index.ts`
- `supabase/functions/ebay-oauth-callback/index.ts`
- `supabase/functions/ebay-feedback-sync/index.ts`
- `supabase/functions/sync-ebay-feedback/index.ts`
- `supabase/functions/ebay-account-deletion/index.ts`

Primary Email Triage files:

- `supabase/functions/microsoft-email-process/index.ts`
- `supabase/functions/microsoft-email-classify/index.ts`
- `supabase/functions/microsoft-email-sync/index.ts`
- `supabase/migrations/20260520143000_email_triage_persistence_foundation.sql`
- `supabase/migrations/20260520193000_email_triage_classification_schema_foundation.sql`
- `supabase/migrations/20260522120000_email_triage_response_draft_persistence.sql`

