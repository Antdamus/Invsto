begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Keep global counts narrow, then calculate evidence and money only for orders
-- in the requested view. Retain every original line for proportional totals.
create index if not exists whatnot_cancelled_buyers on public.whatnot_orders(buyer_id) where status='cancelled';

CREATE OR REPLACE FUNCTION public.whatnot_queue_summary(_view text, _search text, _filter text, _offset integer, _due text, _purchase date, _sort text, _buyer_history text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET jit TO 'off'
AS $function$
declare result jsonb; today date:=(now() at time zone 'America/New_York')::date;
begin
 if not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory staff access required'; end if;
 if _view not in('pending','review','history','all','closeout','market_open','market_completed','market_cancelled','market_failed','unfulfilled') or _offset<0 or length(_search)>200
 or _due not in('all','overdue','today','tomorrow','unknown')
 or _filter not in('all','ready','waiting','missing','watches','missing_watch','cgl','cancel','no_tracking','no_screenshot')
 or _buyer_history not in('all','cancellations','none') then raise exception 'Invalid queue filter';end if;
 with scoped as materialized (
  select l.id,l.order_id,l.work_state,l.shipment_status,l.holds,l.replacement_shipment_id,
   o.status,public.whatnot_line_scope(l,o) as scope
  from public.whatnot_order_lines l join public.whatnot_orders o on o.id=l.order_id
 ), membership as materialized (
  select id,order_id,scope,array_remove(array[
   'all',scope,case when status='completed' and work_state='pending' and scope<>'pending' then 'pending' end,
   case when status='completed' and work_state='pending' then 'closeout' end,
   case when status in ('pending','pending_fulfillment') then 'market_open'
        when status='completed' then 'market_completed' when status='cancelled' then 'market_cancelled' when status='failed' then 'market_failed' end,
   case when status='pending_fulfillment' and coalesce(shipment_status,'created') in ('created','label_generated')
    and not (holds ? 'order_pending_cancellation') and replacement_shipment_id is null then 'unfulfilled' end
  ],null) as queue_views from scoped
 ), candidate_orders as materialized (
  select distinct m.order_id from membership m join public.whatnot_orders o on o.id=m.order_id
  where _view=any(m.queue_views)
   and (_purchase is null or (o.purchased_at at time zone 'America/New_York')::date=_purchase)
 ), photos as (
  select link.line_id,count(distinct file.id) as captures
  from public.whatnot_order_files file cross join lateral unnest(file.line_ids) as link(line_id)
  where file.kind='item_photo' group by link.line_id
 ), labels as (
  select link.line_id,bool_or(f.snapshot @> jsonb_build_array(jsonb_build_object(
   'id',l.id,'quantity',l.quantity,'tracking_number',l.tracking_number))) as current_pdf
  from public.whatnot_order_files f cross join lateral unnest(f.line_ids) as link(line_id)
  join public.whatnot_order_lines l on l.id=link.line_id where f.kind='label' group by link.line_id
 ), queue as (
  select l.*,m.scope,coalesce(p.captures,0) as screenshot_count,
   row_number() over(partition by l.order_id order by l.id) as line_number,
   count(*) over w as order_lines,sum(l.quantity) over w as order_units,
   count(*) filter(where p.captures is null) over w as order_missing_screenshots,
   m.queue_views,shipping.label_state,
   count(*) filter(where shipping.label_state in ('attached','review')) over w as order_label_pdfs,
   count(*) filter(where shipping.label_state='issued') over w as order_labels_issued_only,
   count(*) filter(where shipping.label_state='review') over w as order_label_pdfs_to_check
  from candidate_orders c join public.whatnot_order_lines l on l.order_id=c.order_id
  join membership m on m.id=l.id
  left join photos p on p.line_id=l.id left join labels on labels.line_id=l.id
  cross join lateral (select case when labels.current_pdf then 'attached'
   when labels.line_id is not null then 'review'
   when l.shipment_id is not null and l.replacement_shipment_id is null and nullif(trim(l.tracking_number),'') is not null
    and l.shipment_status in ('label_generated','dropped_off','in_transit','delivered') then 'issued'
   else 'missing' end as label_state) shipping
  window w as (partition by l.order_id)
 ), raw as (
  select l.*,to_jsonb(o) as order_record,
   coalesce(o.buyer_id,'order:'||o.id) as buyer_key,coalesce(o.username,'Buyer not provided') as buyer,
   coalesce(o.customer_name,'') as customer,o.purchased_at,o.status as market_status,
   l.unit_price*l.quantity as gross,case when o.status in ('pending_fulfillment','completed') then o.shipping end as freight,o.total as checkout,o.subtotal,
   l.watch_missing or l.title ~* '\m(watch|watches|wristwatch|wristwatches|smartwatch|smartwatches)\M' as watch,
   l.cancel_pending or l.holds ? 'order_pending_cancellation' as cancel,
   nullif(trim(l.tracking_number),'') is null as no_tracking
  from public.whatnot_orders o join queue l on l.order_id=o.id
 ), weights as (
  select r.*,case when sum(gross) over(partition by order_id)>0 then gross else quantity end as weight,
   case when r.order_record->>'buyer_id' is null then market_status='cancelled' else exists(select 1 from public.whatnot_orders cancelled_order where cancelled_order.buyer_id=r.order_record->>'buyer_id' and cancelled_order.status='cancelled') end as buyer_cancelled
  from raw r
 ), shares as (
  select w.*,sum(weight) over(partition by order_id order by id rows unbounded preceding) as cumulative,
   sum(weight) over(partition by order_id) as denominator,
   (scope='review' or item_missing or watch_missing or cgl_pending or cancel) as blocked,
   case when market_status='completed' then 'closed' when ship_by_date is null then 'unknown' when ship_by_date<today then 'overdue'
    when ship_by_date=today then 'today' when ship_by_date=today+1 then 'tomorrow' else 'future' end as due_key,
   -- Public US standard-rate scenario. Account tiers and category promotions
   -- aren't supplied by the order feed. No estimate for foreign currency/unpaid.
   case when currency='USD' and market_status in ('pending_fulfillment','completed') then
     round(subtotal*.08,2)+round(checkout*.029,2)+.30 end as fee_estimate
  from weights w
 ), base as (
  select s.*,round(freight*cumulative/denominator,2)-round(freight*(cumulative-weight)/denominator,2) as ship_share,
   round(fee_estimate*cumulative/denominator,2)-round(fee_estimate*(cumulative-weight)/denominator,2) as fee_share,
   array_remove(array['all',case when scope<>'history' then case when blocked then 'waiting' else 'ready' end end,
    case when item_missing then 'missing' end,case when watch then 'watches' end,
    case when watch_missing or (watch and item_missing) then 'missing_watch' end,
    case when cgl_pending then 'cgl' end,case when cancel then 'cancel' end,case when no_tracking then 'no_tracking' end,
    case when screenshot_count=0 then 'no_screenshot' end],null) as work_keys
  from shares s
 ), searched as (
  select * from base where _view=any(queue_views)
  and (_purchase is null or (purchased_at at time zone 'America/New_York')::date=_purchase)
  and (_buyer_history='all' or buyer_cancelled=(_buyer_history='cancellations'))
  and (case when left(_search,6)='!scan:' then
   substring(_search from 7) ~ '^[a-z0-9]{6,128}$' and exists (
    select 1 from unnest(array[tracking_number,last_mile_tracking]) as code
    where strpos(regexp_replace(lower(code),'[[:space:]-]','','g'),right(substring(_search from 7),12))>0)
   else (strpos(lower(concat_ws(' ',order_id,buyer,customer,title,sku,tracking_number,last_mile_tracking)),lower(_search))>0
   or (_search ~* '^(]c1)?([0-9 -]{6,128}|1z[a-z0-9 -]{4,126})$' and
    strpos(lower(replace(replace(concat_ws('|',tracking_number,last_mile_tracking),'-',''),' ','')),right(regexp_replace(lower(_search),'^(]c1)|[ -]','','g'),12))>0)) end)
 ), filtered as (
  select * from searched where _filter=any(work_keys) and (_due='all' or due_key=_due)
 ), entries as (
  select 'due:'||k as facet,s.* from searched s cross join lateral unnest(array['all',due_key]) k where _filter=any(work_keys)
  union all select 'work:'||k,s.* from searched s cross join lateral unnest(work_keys) k where _due='all' or due_key=_due
  union all select 'shown',f.* from filtered f
 ), sums as (
  select facet,currency,count(*) as lines,sum(gross) as sales,sum(ship_share) as shipping,sum(fee_share) as fees,
   count(*) filter(where ship_share is null) as unknown_ship,count(*) filter(where fee_share is null) as unknown_fees from entries group by facet,currency
 ), facets as (
  select facet,count(*) as lines,count(distinct order_id) as orders,count(distinct buyer_key) as buyers,
   sum(quantity) as units,(select jsonb_object_agg(currency,to_jsonb(m)-'facet'-'currency') from sums m where m.facet=e.facet) as amounts
  from entries e group by facet
 ), buyers as (
  select buyer_key,min(buyer) as buyer,min(customer) as customer,min(ship_by_date) as due,min(purchased_at) as placed,
   sum(gross) as value from filtered group by buyer_key
 ), page as (
  select b.*,row_number() over(order by
   case when _sort='newest' then placed end desc nulls last,case when _sort='oldest' then placed end nulls last,
   case when _sort='value' then value end desc,case when _sort='low' then value end,
   case when _sort='due' then due end nulls last,case when _sort='latest' then due end desc nulls last,
   case when _sort='buyer_desc' then lower(buyer) end desc,lower(buyer),buyer_key) as seq from buyers b
 ), groups as (
  select p.*, (select jsonb_agg(to_jsonb(f)-'work_keys' order by purchased_at,order_id,id) from filtered f where f.buyer_key=p.buyer_key) as lines
  from page p where seq>_offset and seq<=_offset+40
 ) select jsonb_build_object('groups',coalesce((select jsonb_agg(to_jsonb(g) order by seq) from groups g),'[]'),
 'buyers',(select count(*) from buyers),'visible_lines',(select count(*) from filtered),'visible_items',(select coalesce(sum(quantity),0) from filtered),
 'counts',(select jsonb_build_object('pending',count(*) filter(where 'pending'=any(queue_views)),'closeout',count(*) filter(where 'closeout'=any(queue_views)),'review',count(*) filter(where scope='review'),'history',count(*) filter(where scope='history'),'all',count(*)) from membership),
 'market_counts',(select jsonb_object_agg(category,n) from
    (select category,count(distinct order_id) as n from membership cross join lateral unnest(queue_views) category
     where category in ('market_open','market_completed','market_cancelled','market_failed','unfulfilled') group by category) c),
 'facets',coalesce((select jsonb_object_agg(facet,to_jsonb(f)-'facet') from facets f),'{}')) into result;
 return result;
end$function$;
notify pgrst,'reload schema';
commit;
