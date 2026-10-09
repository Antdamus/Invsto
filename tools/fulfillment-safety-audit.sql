-- Read-only. A current refund does not establish that it preceded fulfillment.
with affected as (
 select o.order_number,o.buyer_username,l.item_title,l.line_status,l.fulfilled_quantity,l.fulfilled_at,
 l.fulfilled_by is not null locally_completed,
 public.ebay_fulfillment_block(to_jsonb(o),to_jsonb(l)) reason,
 case when public.ebay_fulfillment_block(jsonb_build_object('raw_payload',jsonb_build_object('pending_order_sync_mismatch',o.raw_payload->'pending_order_sync_mismatch'))) is not null
  and o.raw_payload#>>'{pending_order_sync_mismatch,detectedAt}' ~ '^20[0-9]{2}-'
  then (o.raw_payload#>>'{pending_order_sync_mismatch,detectedAt}')::timestamptz end warning_recorded_at,
 o.raw_payload#>>'{pending_order_sync_mismatch,ebayPaymentStatus}' warning_payment,
 o.raw_payload#>>'{pending_order_sync_mismatch,ebayCancelStatus}' warning_cancellation,
 o.tracking_number,
 (select max(p.dispatched_at) from public.packaging_shipments p join public.packaging_items i on i.shipment_id=p.id where i.order_line_id=l.id and p.status='dispatched') dispatched_at
 from public.ebay_orders o join public.ebay_order_lines l on l.order_id=o.id
 where public.ebay_fulfillment_block(to_jsonb(o),to_jsonb(l)) is not null
)
select jsonb_build_object('summary',(select jsonb_build_object(
 'pending_blocked',count(*) filter(where line_status in ('pending','partially_fulfilled')),
 'fulfilled_status',count(*) filter(where line_status='fulfilled'),
 'local_completion',count(*) filter(where locally_completed and fulfilled_quantity>0),
 'warning_before_local_completion',count(*) filter(where locally_completed and fulfilled_quantity>0 and warning_recorded_at<fulfilled_at),
 'dispatched_packaging',count(*) filter(where dispatched_at is not null)) from affected),
 'records',(select jsonb_agg(a) from (select * from affected where line_status in ('pending','partially_fulfilled') or (locally_completed and fulfilled_quantity>0) order by fulfilled_at desc nulls first,order_number) a)) audit;
