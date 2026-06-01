-- Remove cleared eBay reconciliation markers that were stored as JSON null.
-- Active review markers are JSON objects and are left intact.

update public.ebay_orders
set raw_payload = raw_payload - 'pending_order_sync_mismatch',
    updated_at = now()
where jsonb_typeof(raw_payload->'pending_order_sync_mismatch') = 'null';
