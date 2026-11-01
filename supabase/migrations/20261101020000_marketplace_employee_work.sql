begin;
set local lock_timeout='8s';

-- Keep the contribution of each worker even when another person closes the last
-- line, or an order is later reopened. Existing eBay whole-order receipts stay authoritative.
create table public.marketplace_work_closures(
 id bigint generated always as identity primary key,market text not null,
 order_id text not null,line_id text,actor uuid not null,closed_at timestamptz not null,
 order_number text not null,buyer text,items jsonb not null,basis text not null,
 note text,extra jsonb not null default '{}'
);
create unique index marketplace_work_closure_once on public.marketplace_work_closures
 (market,order_id,coalesce(line_id,''),actor,closed_at);
create index marketplace_work_by_employee on public.marketplace_work_closures(actor,closed_at);
create index marketplace_work_by_time on public.marketplace_work_closures(closed_at);
alter table public.marketplace_work_closures enable row level security;
revoke all on public.marketplace_work_closures from public,anon,authenticated;

create function public.capture_work_fulfilled_line() returns trigger
language plpgsql security definer set search_path='' as $$
declare number text; buyer_name text; item text; market_name text;
begin
 if new.fulfilled_by is null or new.fulfilled_at is null or auth.uid() is distinct from new.fulfilled_by then return null;end if;
 if tg_table_name='ebay_order_lines' then
  if new.line_status<>'fulfilled' or coalesce(new.fulfilled_quantity,0)<new.quantity then return null;end if;
  if old.line_status='fulfilled' and old.fulfilled_quantity>=old.quantity and old.fulfilled_at=new.fulfilled_at then return null;end if;
  select o.order_number,o.buyer_username into number,buyer_name from public.ebay_orders o where o.id=new.order_id;
  item:=new.item_title;market_name:='ebay';
 else
  if new.cancelled_at is not null or old.fulfilled_at is not null then return null;end if;
  select o.order_number,o.buyer_username into number,buyer_name from public.tiktok_orders o where o.id=new.order_id;
  item:=new.title;market_name:='tiktok';
 end if;
 insert into public.marketplace_work_closures(market,order_id,line_id,actor,closed_at,order_number,buyer,items,basis)
 values(market_name,new.order_id::text,new.id::text,new.fulfilled_by,new.fulfilled_at,coalesce(number,new.order_id::text),buyer_name,
 jsonb_build_array(jsonb_build_object('order_line_id',new.id,'item_title',item,'fulfilled_quantity',new.quantity,'status','fulfilled')),'signed_line_completion')
 on conflict do nothing;
 return null;
end$$;
revoke all on function public.capture_work_fulfilled_line() from public,anon,authenticated;
create trigger capture_ebay_work_line after update on public.ebay_order_lines for each row
 when(new.fulfilled_at is not null and new.line_status='fulfilled' and
 (new.fulfilled_at is distinct from old.fulfilled_at or new.line_status is distinct from old.line_status or new.fulfilled_quantity is distinct from old.fulfilled_quantity))
 execute function public.capture_work_fulfilled_line();
create trigger capture_tiktok_work_line after update on public.tiktok_order_lines for each row
 when(new.fulfilled_at is not null and old.fulfilled_at is null) execute function public.capture_work_fulfilled_line();

-- Use signed line-level attribution for existing eBay lines, never the final signer of a grouped order.
insert into public.marketplace_work_closures(market,order_id,line_id,actor,closed_at,order_number,buyer,items,basis)
select 'ebay',o.id::text,l.id::text,l.fulfilled_by,l.fulfilled_at,coalesce(o.order_number,o.id::text),o.buyer_username,
 jsonb_build_array(jsonb_build_object('order_line_id',l.id,'item_title',l.item_title,'fulfilled_quantity',l.fulfilled_quantity,'status','fulfilled')),'saved_line_fulfillment'
from public.ebay_order_lines l join public.ebay_orders o on o.id=l.order_id
where l.line_status='fulfilled' and l.fulfilled_by is not null and l.fulfilled_at is not null and l.fulfilled_quantity>=l.quantity;

-- Each review's items belong to that order. selected_line_ids can span several orders.
insert into public.marketplace_work_closures(market,order_id,line_id,actor,closed_at,order_number,buyer,items,basis)
select 'tiktok',o.id::text,i->>'line_id',e.actor,e.created_at,o.order_number,o.buyer_username,
 jsonb_build_array(jsonb_build_object('order_line_id',i->>'line_id','item_title',coalesce(l.title,i->>'sku_id'),'fulfilled_quantity',i->'quantity','status','fulfilled')),'signed_completion_review'
from public.tiktok_order_events e join public.tiktok_orders o on o.id=e.order_id
cross join lateral jsonb_array_elements(e.details->'items') i
left join public.tiktok_order_lines l on l.order_id=o.id and l.id::text=i->>'line_id'
where e.action='completion_review' and e.actor is not null and i->>'line_id' is not null on conflict do nothing;
insert into public.marketplace_work_closures(market,order_id,line_id,actor,closed_at,order_number,buyer,items,basis)
select 'tiktok',o.id::text,l.id::text,l.fulfilled_by,l.fulfilled_at,o.order_number,o.buyer_username,
 jsonb_build_array(jsonb_build_object('order_line_id',l.id,'item_title',l.title,'fulfilled_quantity',l.quantity,'status','fulfilled')),'saved_line_fulfillment'
from public.tiktok_order_lines l join public.tiktok_orders o on o.id=l.order_id
where l.fulfilled_by is not null and l.fulfilled_at is not null and (l.cancelled_at is null or l.cancelled_at>l.fulfilled_at) on conflict do nothing;

create function public.record_whatnot_work_closure(e public.whatnot_order_events,historical boolean) returns void
language plpgsql security definer set search_path='' as $$
declare l public.whatnot_order_lines; buyer_name text; credited uuid:=e.actor; proof text:='signed_completion';
 info jsonb:='{}'; all_items jsonb;
begin
 if e.action<>'complete' or e.line_id is null then return;end if;
 perform pg_advisory_xact_lock(hashtextextended('whatnot-work:'||e.order_id,0));
 select * into l from public.whatnot_order_lines where id=e.line_id and order_id=e.order_id;
 if not found then return;end if;
 if e.actor is null then
  if e.details->>'record_basis' is distinct from 'admin_authorized_label_closeout' or l.completed_at is distinct from e.created_at
   or l.completed_by is null or l.completed_by::text is distinct from e.details->>'credited_user_id' then return;end if;
  credited:=l.completed_by;proof:='admin_authorized_label_closeout';
  info:=jsonb_build_object('recorded_by',e.actor_name,'photo_requirement_waived',e.details->'photo_requirement_waived',
   'label_source',e.details->'label_source','tracking_number',e.details->'tracking_number','marketplace_status_at_close',e.details->'marketplace_status_at_close');
 end if;
 select username into buyer_name from public.whatnot_orders where id=e.order_id;
 insert into public.marketplace_work_closures(market,order_id,line_id,actor,closed_at,order_number,buyer,items,basis,note,extra)
 values('whatnot',e.order_id,e.line_id,credited,e.created_at,e.order_id,buyer_name,jsonb_build_array(jsonb_build_object(
  'order_line_id',e.line_id,'item_title',l.title,'fulfilled_quantity',coalesce(e.details->'quantity',to_jsonb(l.quantity)),'status','fulfilled')),
  proof,e.details->>'note',info) on conflict do nothing;
 if exists(select 1 from public.whatnot_order_lines x where x.order_id=e.order_id and x.work_state='pending') then return;end if;
 if historical and (l.completed_at is distinct from e.created_at or l.completed_by is distinct from credited
  or l.id is distinct from (select x.id from public.whatnot_order_lines x where x.order_id=e.order_id and x.work_state='completed' order by x.completed_at desc nulls last,x.id desc limit 1)) then return;end if;
 select jsonb_agg(jsonb_build_object('order_line_id',x.id,'item_title',x.title,'fulfilled_quantity',x.quantity,
   'status',case when x.work_state='completed' then 'fulfilled' else 'marketplace_history' end) order by x.id)
 into all_items from public.whatnot_order_lines x where x.order_id=e.order_id;
 insert into public.marketplace_work_closures(market,order_id,actor,closed_at,order_number,buyer,items,basis,note,extra)
 values('whatnot',e.order_id,credited,e.created_at,e.order_id,buyer_name,all_items,proof,e.details->>'note',info) on conflict do nothing;
end$$;
create function public.capture_whatnot_work_event() returns trigger language plpgsql security definer set search_path='' as $$
begin perform public.record_whatnot_work_closure(new,false);return null;end$$;
revoke all on function public.record_whatnot_work_closure(public.whatnot_order_events,boolean),public.capture_whatnot_work_event() from public,anon,authenticated;
create trigger capture_whatnot_work_event after insert on public.whatnot_order_events for each row when(new.action='complete') execute function public.capture_whatnot_work_event();
do $$declare e public.whatnot_order_events;begin
 for e in select * from public.whatnot_order_events where action='complete' order by created_at,id loop perform public.record_whatnot_work_closure(e,true);end loop;
end$$;

-- A TikTok order_completed event is emitted only on the final close. Keep this independent of line credit.
create view public.marketplace_employee_work_events as
select 'marketplace_work:'||c.id as event_key,'marketplace_work_closures'::text as source,c.actor as actor_user_id,c.closed_at as occurred_at,
 case when c.line_id is null then 'closed_orders' else 'closed_lines' end as category,
 case when c.line_id is null then 'pending_order_closed' else 'order_line_closed' end as action,
 c.order_number||coalesce(' · '||c.buyer,'') as title,c.note as notes,c.market||':'||coalesce(c.line_id,c.order_id) as entity_id,
 case when c.line_id is null then 'pending_orders_closed' else 'order_lines_closed' end as metric,0::numeric as quantity,
 jsonb_build_object('marketplace',c.market,'order_number',c.order_number,'buyer_username',c.buyer,'items',c.items,'record_basis',c.basis)||c.extra as details
from public.marketplace_work_closures c
union all
select 'tiktok_order_completed:'||e.id,'tiktok_order_events',e.actor,e.created_at,'closed_orders','pending_order_closed',
 o.order_number||coalesce(' · '||o.buyer_username,''),null,'tiktok:'||o.id,'pending_orders_closed',0::numeric,
 jsonb_build_object('marketplace','tiktok','order_number',o.order_number,'buyer_username',o.buyer_username,'record_basis','signed_completion',
 'items',coalesce((select jsonb_agg(s.item order by s.line_id) from (
   select distinct on (c.line_id) c.line_id,c.items->0 as item from public.marketplace_work_closures c
   where c.market='tiktok' and c.order_id=o.id::text and c.line_id is not null and c.closed_at<=e.created_at order by c.line_id,c.closed_at desc) s),'[]'::jsonb))
from public.tiktok_order_events e join public.tiktok_orders o on o.id=e.order_id where e.actor is not null and
 (e.action='order_completed' or (e.action='work_update' and e.details->>'to' in ('completed','dispatched')
  and e.details->>'from' not in ('completed','dispatched') and exists(select 1 from public.marketplace_work_closures c
   where c.market='tiktok' and c.order_id=o.id::text and c.actor=e.actor and c.closed_at=e.created_at)
  and not exists(select 1 from public.tiktok_order_events other where other.order_id=e.order_id and other.action='order_completed'
   and other.actor=e.actor and other.created_at=e.created_at)));
revoke all on public.marketplace_employee_work_events from public,anon,authenticated;

do $$declare def text; metric_key text:='when metric=''pending_orders_closed'' then entity_id'; metrics_start text:='select actor_user_id,jsonb_object_agg(metric,n) data from metric_counts group by actor_user_id';begin
 def:=rtrim(pg_get_viewdef('public.admin_work_event_stream'::regclass,true),E'; \t\r\n');
 execute 'create or replace view public.admin_work_event_stream as '||def||' union all select * from public.marketplace_employee_work_events';
 def:=pg_get_functiondef('public.admin_employee_work_report(date,uuid,uuid,text,text,integer,integer,timestamptz)'::regprocedure);
 if strpos(def,metric_key)=0 or strpos(def,metrics_start)=0 then raise exception 'Unexpected work report metric definition';end if;
 def:=replace(def,metric_key,'when metric in (''pending_orders_closed'',''order_lines_closed'') then entity_id');
 def:=replace(def,metrics_start,$metrics$select actor_user_id,jsonb_object_agg(metric,n) data from (
    select * from metric_counts union all
    select actor_user_id,metric||'_'||coalesce(details->>'marketplace','ebay'),count(distinct entity_id)
    from base where metric in ('pending_orders_closed','order_lines_closed') group by actor_user_id,metric,coalesce(details->>'marketplace','ebay')
   ) per_market group by actor_user_id$metrics$);
 execute def;
end$$;
notify pgrst,'reload schema';
commit;
