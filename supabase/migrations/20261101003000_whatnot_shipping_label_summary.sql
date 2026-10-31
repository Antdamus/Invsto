begin;
set local lock_timeout='5s';
create or replace view public.whatnot_queue_lines with (security_invoker=true) as
 with photos as (
  select line_id,count(distinct file.id) as captures
  from public.whatnot_order_files file cross join lateral unnest(file.line_ids) as link(line_id)
  where file.kind='item_photo' group by line_id
 ), labels as (
  select link.line_id, bool_or(f.snapshot @> jsonb_build_array(jsonb_build_object(
   'id',l.id,'quantity',l.quantity,'tracking_number',l.tracking_number))) as current_pdf
  from public.whatnot_order_files f cross join lateral unnest(f.line_ids) as link(line_id)
  join public.whatnot_order_lines l on l.id=link.line_id
  where f.kind='label' group by link.line_id
 )
 select l.*,public.whatnot_line_scope(l,o) as scope,coalesce(p.captures,0) as screenshot_count,
  row_number() over(partition by l.order_id order by l.id) as line_number,
  count(*) over w as order_lines,sum(l.quantity) over w as order_units,
  count(*) filter(where p.captures is null) over w as order_missing_screenshots,
  array_remove(array[
   'all',public.whatnot_line_scope(l,o),case when o.status='completed' and l.work_state='pending' and public.whatnot_line_scope(l,o)<>'pending' then 'pending' end,
   case when o.status='completed' and l.work_state='pending' then 'closeout' end,
   case when o.status in ('pending','pending_fulfillment') then 'market_open'
        when o.status='completed' then 'market_completed' when o.status='cancelled' then 'market_cancelled' when o.status='failed' then 'market_failed' end,
   case when o.status='pending_fulfillment' and coalesce(l.shipment_status,'created') in ('created','label_generated')
    and not (l.holds ? 'order_pending_cancellation') and l.replacement_shipment_id is null then 'unfulfilled' end
  ],null) as queue_views,
  shipping.label_state,
  count(*) filter(where shipping.label_state in ('attached','review')) over w as order_label_pdfs,
  count(*) filter(where shipping.label_state='issued') over w as order_labels_issued_only,
  count(*) filter(where shipping.label_state='review') over w as order_label_pdfs_to_check
 from public.whatnot_order_lines l join public.whatnot_orders o on o.id=l.order_id
 left join photos p on p.line_id=l.id
 left join labels on labels.line_id=l.id
 cross join lateral (select case
  when labels.current_pdf then 'attached'
  when labels.line_id is not null then 'review'
  when l.shipment_id is not null and l.replacement_shipment_id is null and nullif(trim(l.tracking_number),'') is not null
   and l.shipment_status in ('label_generated','dropped_off','in_transit','delivered') then 'issued'
  else 'missing' end as label_state) shipping
 window w as (partition by l.order_id);
notify pgrst,'reload schema';
commit;
