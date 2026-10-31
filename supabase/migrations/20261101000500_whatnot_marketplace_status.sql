begin;
set local lock_timeout='5s';
select pg_advisory_xact_lock(hashtext('whatnot-import'));
-- Only a source timestamp or an earlier observed completed status can establish that completion predates today.
-- The saved line state carries outstanding closeout work across midnight and repeat imports.
with completed as (
 select o.id,least(o.source_updated_at,(select max(e.created_at) from public.whatnot_order_events e
  where e.order_id=o.id and e.line_id is null and e.action in ('order_imported','status_updated') and e.details->>'status'='completed')) as known_by
 from public.whatnot_orders o where o.status='completed'
), changes as (
 select l.id,case when c.known_by < (date_trunc('day',now() at time zone 'America/New_York') at time zone 'America/New_York') then 'external_history' else 'pending' end as desired
 from public.whatnot_order_lines l join completed c on c.id=l.order_id
 where l.work_state<>'completed' and not exists(select 1 from public.whatnot_order_events e where e.line_id=l.id and e.action='reopen')
)
update public.whatnot_order_lines l set work_state=c.desired,revision=revision+1 from changes c where l.id=c.id and l.work_state<>c.desired;

create or replace function public.import_whatnot_order(_record jsonb) returns void language plpgsql security definer set search_path='' as $$
declare r jsonb;old public.whatnot_orders;l public.whatnot_order_lines;oid text:=_record->>'id';changed boolean;initial_state text;
begin
 perform pg_advisory_xact_lock(hashtext('whatnot-import'));
 if jsonb_typeof(_record->'lines') is distinct from 'array' or jsonb_array_length(_record->'lines')<1 then raise exception 'Complete order items required';end if;
 select * into old from public.whatnot_orders where id=oid;
 if old.source_updated_at>(_record->>'source_updated_at')::timestamptz then return;end if;
 insert into public.whatnot_orders(id,url,status,buyer_id,username,customer_name,purchased_at,source_updated_at,cancelled_at,currency,subtotal,shipping,tax,total,show_id,show_title,show_url)
 select x.id,x.url,x.status,x.buyer_id,x.username,x.customer_name,x.purchased_at,x.source_updated_at,x.cancelled_at,x.currency,x.subtotal,x.shipping,x.tax,x.total,x.show_id,x.show_title,x.show_url
 from jsonb_populate_record(null::public.whatnot_orders,_record) x
 on conflict(id) do update set url=excluded.url,status=excluded.status,buyer_id=coalesce(excluded.buyer_id,whatnot_orders.buyer_id),username=coalesce(excluded.username,whatnot_orders.username),customer_name=coalesce(excluded.customer_name,whatnot_orders.customer_name),
 purchased_at=coalesce(excluded.purchased_at,whatnot_orders.purchased_at),source_updated_at=excluded.source_updated_at,cancelled_at=excluded.cancelled_at,currency=excluded.currency,subtotal=excluded.subtotal,shipping=excluded.shipping,tax=excluded.tax,total=excluded.total,
 show_id=excluded.show_id,show_title=excluded.show_title,show_url=excluded.show_url,synced_at=now();
 for r in select value from jsonb_array_elements(_record->'lines') loop
  if r->>'order_id' is distinct from oid then raise exception 'Order item mismatch';end if;
  select * into l from public.whatnot_order_lines where id=r->>'id' for update;
  if found and l.order_id<>oid then raise exception 'Order item moved between orders';end if;
  changed:=l.id is not null and (l.quantity is distinct from (r->>'quantity')::int or l.shipment_id is distinct from r->>'shipment_id' or l.tracking_number is distinct from r->>'tracking_number' or l.holds is distinct from r->'holds');
  initial_state:=case when _record->>'status'='completed' and
   (coalesce((_record->>'source_updated_at')::timestamptz,now()) at time zone 'America/New_York')::date >= (now() at time zone 'America/New_York')::date then 'pending'
   when _record->>'status' in('completed','cancelled') or r->>'shipment_status' in('dropped_off','in_transit','delivered') then 'external_history' else 'pending' end;
  insert into public.whatnot_order_lines(id,order_id,title,sku,product_id,quantity,unit_price,currency,shipment_id,shipment_url,shipment_status,tracking_number,last_mile_tracking,carrier,ship_by_date,dropoff_due,holds,replacement_shipment_id,work_state)
  select x.id,x.order_id,x.title,x.sku,x.product_id,x.quantity,x.unit_price,x.currency,x.shipment_id,x.shipment_url,x.shipment_status,x.tracking_number,x.last_mile_tracking,x.carrier,x.ship_by_date,x.dropoff_due,coalesce(x.holds,'[]'),x.replacement_shipment_id,initial_state
  from jsonb_populate_record(null::public.whatnot_order_lines,r) x
  on conflict(id) do update set title=excluded.title,sku=excluded.sku,product_id=excluded.product_id,quantity=excluded.quantity,unit_price=excluded.unit_price,currency=excluded.currency,
   shipment_id=excluded.shipment_id,shipment_url=excluded.shipment_url,shipment_status=excluded.shipment_status,tracking_number=excluded.tracking_number,last_mile_tracking=excluded.last_mile_tracking,carrier=excluded.carrier,
   ship_by_date=excluded.ship_by_date,dropoff_due=excluded.dropoff_due,holds=excluded.holds,replacement_shipment_id=excluded.replacement_shipment_id,
   work_state=case when changed and whatnot_order_lines.work_state='completed' then 'pending'
    when old.status is distinct from _record->>'status' and whatnot_order_lines.work_state<>'completed'
     and (old.status in ('completed','cancelled') or _record->>'status' in ('completed','cancelled')) then excluded.work_state
    else whatnot_order_lines.work_state end,
   completed_at=case when changed then null else whatnot_order_lines.completed_at end,completed_by=case when changed then null else whatnot_order_lines.completed_by end,
   revision=whatnot_order_lines.revision+case when changed or old.status is distinct from _record->>'status' then 1 else 0 end,synced_at=now();
  if changed then insert into public.whatnot_order_events(order_id,line_id,actor_name,action,details) values(oid,l.id,'Whatnot API','shipment_or_quantity_updated',jsonb_build_object('before',jsonb_build_object('quantity',l.quantity,'shipment_id',l.shipment_id,'tracking_number',l.tracking_number),'after',r,'completion_reopened',l.work_state='completed'));end if;
 end loop;
 -- Never delete absent lines or infer cancellations from a missing page.
 if old.id is null or old.status is distinct from _record->>'status' then
  insert into public.whatnot_order_events(order_id,actor_name,action,details) values(oid,'Whatnot API',case when old.id is null then 'order_imported' else 'status_updated' end,jsonb_build_object('status',_record->>'status','previous_status',old.status));
 end if;
end$$;
revoke all on function public.import_whatnot_order(jsonb) from public,anon,authenticated;
grant execute on function public.import_whatnot_order(jsonb) to service_role;

create or replace function public.whatnot_work_action(_action text,_lines jsonb,_value text default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb;l public.whatnot_order_lines;o public.whatnot_orders;who text;n int:=0;source_label boolean;
begin
 if not coalesce(public.can_manage_inventory(),false) or auth.uid() is null then raise exception 'Inventory staff access required';end if;
 if _action not in('note','missing','found','cgl','cgl_done','watch_missing','watch_found','cancel_pending','cancel_clear','receipt','complete','reopen') or jsonb_typeof(_lines) is distinct from 'array' or jsonb_array_length(_lines) not between 1 and 250 then raise exception 'Invalid action or selected items';end if;
 if length(coalesce(_value,''))>4000 then raise exception 'Text is too long';end if;
 if _action in('note','reopen') and length(trim(coalesce(_value,'')))<3 then raise exception 'Enter a note explaining this action';end if;
 if _action='reopen' and not coalesce(public.is_admin(),false) then raise exception 'Administrator access required to reopen';end if;
 if _action='receipt' and coalesce(_value,'')!~'^https://(www\.)?whatnot\.com/' then raise exception 'Use a Whatnot receipt or order link';end if;
 perform 1 from public.whatnot_orders where id in(select order_id from public.whatnot_order_lines where id in(select value->>'id' from jsonb_array_elements(_lines))) order by id for share;
 select coalesce(nullif(display_name,''),email,'Staff') into who from public.employees where user_id=auth.uid() limit 1;
 for r in select value from jsonb_array_elements(_lines) order by value->>'id' loop
  select * into l from public.whatnot_order_lines where id=r->>'id' for update;
  if not found or l.revision is distinct from (r->>'revision')::int then raise exception 'Items changed. Reload and review your selection.';end if;
  select * into o from public.whatnot_orders where id=l.order_id;
  if _action in ('watch_missing','watch_found','cancel_pending','cancel_clear') and public.whatnot_line_scope(l,o)='history' then raise exception 'This item is already in history';end if;
  source_label:=false;
  if _action='complete' then
   if l.work_state='completed' then continue;end if;
   if o.status not in('pending_fulfillment','completed') or public.whatnot_line_scope(l,o)<>'pending' or l.watch_missing or l.cancel_pending or l.item_missing or l.cgl_pending or nullif(l.tracking_number,'') is null then raise exception 'Resolve payment, item, certificate and tracking requirements first';end if;
   source_label:=coalesce(r->>'verified_tracking_number'=l.tracking_number and l.shipment_id is not null
    and l.shipment_status in ('label_generated','dropped_off','in_transit','delivered') and l.replacement_shipment_id is null,false);
   if not source_label and not exists(select 1 from public.whatnot_order_files f where f.kind='label' and l.id=any(f.line_ids) and f.snapshot @> jsonb_build_array(jsonb_build_object('id',l.id,'quantity',l.quantity,'tracking_number',l.tracking_number))) then raise exception 'Attach a verified shipping-label PDF for each selected item';end if;
   if not exists(select 1 from public.whatnot_order_files f where f.kind='completion_photo' and l.id=any(f.line_ids) and f.snapshot @> jsonb_build_array(jsonb_build_object('id',l.id,'quantity',l.quantity)) and (not source_label or f.snapshot @> jsonb_build_array(jsonb_build_object('id',l.id,'tracking_number',l.tracking_number)))) then raise exception 'Take a packing photo for the selected items and their current tracking number';end if;
  end if;
  update public.whatnot_order_lines set watch_missing=case when _action in ('watch_missing','watch_found') then _action='watch_missing' else watch_missing end,
   cancel_pending=case when _action in ('cancel_pending','cancel_clear') then _action='cancel_pending' else cancel_pending end,
   item_missing=case when _action in('missing','found') then _action='missing' else item_missing end,
   cgl_pending=case when _action in('cgl','cgl_done') then _action='cgl' else cgl_pending end,
   receipt_url=case when _action='receipt' then _value else receipt_url end,receipt_saved_by=case when _action='receipt' then auth.uid() else receipt_saved_by end,receipt_saved_at=case when _action='receipt' then now() else receipt_saved_at end,
   work_state=case when _action='complete' then 'completed' when _action='reopen' then 'pending' else work_state end,
   completed_at=case when _action='complete' then now() when _action='reopen' then null else completed_at end,completed_by=case when _action='complete' then auth.uid() when _action='reopen' then null else completed_by end,revision=revision+1 where id=l.id;
  insert into public.whatnot_order_events(order_id,line_id,actor,actor_name,action,details) values(l.order_id,l.id,auth.uid(),coalesce(who,'Staff'),_action,jsonb_build_object('note',_value,'quantity',l.quantity,'tracking_number',l.tracking_number,'marketplace_changed',false,'label_source',case when _action='complete' then case when source_label then 'Whatnot tracking verified by staff' else 'Verified label PDF' end end));n:=n+1;
 end loop;
 return jsonb_build_object('updated',n);
end$$;

create or replace view public.whatnot_queue_lines with (security_invoker=true) as
 with photos as (
  select line_id,count(distinct file.id) as captures
  from public.whatnot_order_files file cross join lateral unnest(file.line_ids) as link(line_id)
  where file.kind='item_photo' group by line_id
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
  ],null) as queue_views
 from public.whatnot_order_lines l join public.whatnot_orders o on o.id=l.order_id
 left join photos p on p.line_id=l.id
 window w as (partition by l.order_id);

create or replace function public.whatnot_queue_summary(_view text,_search text,_filter text,_offset int,
 _due text,_purchase date,_sort text,_buyer_history text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb; today date:=(now() at time zone 'America/New_York')::date;
begin
 if not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory staff access required'; end if;
 if _view not in('pending','review','history','all','closeout','market_open','market_completed','market_cancelled','market_failed','unfulfilled') or _offset<0 or length(_search)>200
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
 'counts',(select jsonb_build_object('pending',count(*) filter(where 'pending'=any(queue_views)),'closeout',count(*) filter(where 'closeout'=any(queue_views)),'review',count(*) filter(where scope='review'),'history',count(*) filter(where scope='history'),'all',count(*)) from base),
 'market_counts',(select jsonb_object_agg(category,n) from
    (select category,count(distinct order_id) as n from base cross join lateral unnest(queue_views) category
     where category in ('market_open','market_completed','market_cancelled','market_failed','unfulfilled') group by category) c),
 'facets',coalesce((select jsonb_object_agg(facet,to_jsonb(f)-'facet') from facets f),'{}')) into result;
 return result;
end$$;
revoke all on function public.whatnot_queue_summary(text,text,text,int,text,date,text,text) from public,anon;
grant execute on function public.whatnot_queue_summary(text,text,text,int,text,date,text,text) to authenticated;
notify pgrst,'reload schema';
commit;
