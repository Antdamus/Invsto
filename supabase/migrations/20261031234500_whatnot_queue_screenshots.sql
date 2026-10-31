begin;
set local lock_timeout='3s';

-- Count item evidence for each original line before applying any queue filter.
create view public.whatnot_queue_lines with (security_invoker=true) as
 with photos as (
  select line_id,count(distinct file.id) as captures
  from public.whatnot_order_files file cross join lateral unnest(file.line_ids) as link(line_id)
  where file.kind='item_photo' group by line_id
 )
 select l.*,public.whatnot_line_scope(l,o) as scope,coalesce(p.captures,0) as screenshot_count,
  row_number() over(partition by l.order_id order by l.id) as line_number,
  count(*) over w as order_lines,sum(l.quantity) over w as order_units,
  count(*) filter(where p.captures is null) over w as order_missing_screenshots
 from public.whatnot_order_lines l join public.whatnot_orders o on o.id=l.order_id
 left join photos p on p.line_id=l.id
 window w as (partition by l.order_id);
revoke all on public.whatnot_queue_lines from public,anon,authenticated;
grant select on public.whatnot_queue_lines to authenticated,service_role;

create or replace function public.whatnot_queue_summary(_view text,_search text,_filter text,_offset int,
 _due text,_purchase date,_sort text,_buyer_history text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb; today date:=(now() at time zone 'America/New_York')::date;
begin
 if not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory staff access required'; end if;
 if _view not in('pending','review','history','all') or _offset<0 or length(_search)>200
 or _due not in('all','overdue','today','tomorrow','unknown')
 or _filter not in('all','ready','waiting','missing','watches','missing_watch','cgl','cancel','no_tracking','no_screenshot')
 or _buyer_history not in('all','cancellations','none') then raise exception 'Invalid queue filter';end if;
 with raw as (
  select l.*,to_jsonb(o) as order_record,
   coalesce(o.buyer_id,'order:'||o.id) as buyer_key,coalesce(o.username,'Buyer not provided') as buyer,
   coalesce(o.customer_name,'') as customer,o.purchased_at,o.status as market_status,
   l.unit_price*l.quantity as gross,case when o.status in ('pending_fulfillment','completed') then o.shipping end as freight,o.total as checkout,o.subtotal,
   l.watch_missing or l.title ~* '\m(watch|watches|wristwatch|wristwatches|smartwatch|smartwatches)\M' as watch,
   l.cancel_pending or l.holds ? 'order_pending_cancellation' as cancel,
   nullif(trim(l.tracking_number),'') is null as no_tracking
  from public.whatnot_orders o join public.whatnot_queue_lines l on l.order_id=o.id
 ), weights as (
  select r.*,case when sum(gross) over(partition by order_id)>0 then gross else quantity end as weight,
   bool_or(market_status='cancelled') over(partition by buyer_key) as buyer_cancelled
  from raw r
 ), shares as (
  select w.*,sum(weight) over(partition by order_id order by id rows unbounded preceding) as cumulative,
   sum(weight) over(partition by order_id) as denominator,
   (scope='review' or item_missing or watch_missing or cgl_pending or cancel) as blocked,
   case when ship_by_date is null then 'unknown' when ship_by_date<today then 'overdue'
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
  select * from base where (_view='all' or _view='pending' and scope<>'history' or scope=_view)
  and (_purchase is null or (purchased_at at time zone 'America/New_York')::date=_purchase)
  and (_buyer_history='all' or buyer_cancelled=(_buyer_history='cancellations'))
  and (strpos(lower(concat_ws(' ',order_id,buyer,customer,title,sku,tracking_number,last_mile_tracking)),lower(_search))>0
   or (_search ~* '^(]c1)?([0-9 -]{6,128}|1z[a-z0-9 -]{4,126})$' and
    strpos(lower(replace(replace(concat_ws('|',tracking_number,last_mile_tracking),'-',''),' ','')),right(regexp_replace(lower(_search),'^(]c1)|[ -]','','g'),12))>0))
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
 'counts',(select jsonb_build_object('pending',count(*) filter(where scope<>'history'),'review',count(*) filter(where scope='review'),'history',count(*) filter(where scope='history'),'all',count(*)) from base),
 'facets',coalesce((select jsonb_object_agg(facet,to_jsonb(f)-'facet') from facets f),'{}')) into result;
 return result;
end$$;
revoke all on function public.whatnot_queue_summary(text,text,text,int,text,date,text,text) from public,anon;
grant execute on function public.whatnot_queue_summary(text,text,text,int,text,date,text,text) to authenticated;
notify pgrst,'reload schema';
commit;
