begin;
set local lock_timeout='3s';
set local statement_timeout='60s';
-- A confirmed finance refund is also a stop, even if order polling still says paid.
do $$ declare definition text;begin
 select pg_get_functiondef('public.ebay_fulfillment_block(jsonb,jsonb)'::regprocedure) into definition;
 if strpos(definition,' p:=upper(coalesce(')=0 then raise exception 'Fulfillment guard definition changed';end if;
 execute replace(definition,' p:=upper(coalesce(', $insert$
 if exists(select 1 from jsonb_array_elements(case when jsonb_typeof(o#>'{ebayFinance,transactions}')='array' then o#>'{ebayFinance,transactions}' else '[]'::jsonb end || case when jsonb_typeof(l#>'{ebayFinance,transactions}')='array' then l#>'{ebayFinance,transactions}' else '[]'::jsonb end) t
  where upper(t->>'transactionType')='REFUND' and upper(coalesce(t->>'transactionStatus','')) not in ('FAILED','CANCELLED','CANCELED','REJECTED')) then return 'Refund recorded by eBay Finances';end if;
 p:=upper(coalesce($insert$);
end $$;
-- Keep future warning chronology separate from the mutable eBay snapshot.
create table public.ebay_fulfillment_safety_events (
 id uuid primary key default gen_random_uuid(),order_id uuid not null references public.ebay_orders(id),
 observed_at timestamptz not null default now(),previous_reason text,reason text,
 source text not null default 'order_status_update'
);
alter table public.ebay_fulfillment_safety_events enable row level security;
revoke all on public.ebay_fulfillment_safety_events from public,anon,authenticated;
create index ebay_fulfillment_safety_order_idx on public.ebay_fulfillment_safety_events(order_id,observed_at);
create or replace function public.record_ebay_fulfillment_safety() returns trigger
language plpgsql security definer set search_path='' as $$
declare reason text:=public.ebay_fulfillment_block(to_jsonb(new));prior text:=public.ebay_fulfillment_block(to_jsonb(old));p record;
begin
 if reason is not distinct from prior then return new;end if;
 insert into public.ebay_fulfillment_safety_events(order_id,previous_reason,reason) values(new.id,prior,reason);
 if reason is not null then
  for p in update public.packaging_shipments set status='on_hold',hold_reason='Do not ship: '||reason,revision=revision+1,updated_at=now()
   where new.id=any(order_ids) and status in ('in_progress','ready') returning id loop
   insert into public.packaging_events(shipment_id,request_id,action,notes,payload,created_by)
   select p.id,gen_random_uuid(),'payment_safety_hold','Do not ship: '||reason,jsonb_build_object('order_id',new.id,'reason',reason),coalesce(auth.uid(),s.created_by) from public.packaging_shipments s where s.id=p.id;
  end loop;
 end if;
 return new;
end $$;
create trigger record_ebay_fulfillment_safety after update of status,raw_payload on public.ebay_orders for each row execute function public.record_ebay_fulfillment_safety();

-- An eBay label applies to an order, so validate every line in that order,
-- including lines outside the browser's currently loaded page.
create or replace function public.check_ebay_fulfillment_allowed(_line_ids uuid[])
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory staff access required' using errcode='42501';end if;
 if coalesce(cardinality(_line_ids),0) not between 1 and 500 then raise exception 'Select between 1 and 500 order items';end if;
 select coalesce(jsonb_agg(jsonb_build_object('line_id',l.id,'order_number',o.order_number,'reason',public.ebay_fulfillment_block(to_jsonb(o),to_jsonb(l)))),'[]') into result
 from public.ebay_order_lines l join public.ebay_orders o on o.id=l.order_id where l.order_id in (select order_id from public.ebay_order_lines where id=any(_line_ids)) and public.ebay_fulfillment_block(to_jsonb(o),to_jsonb(l)) is not null;
 if (select count(*) from public.ebay_order_lines where id=any(_line_ids))<>(select count(distinct x) from unnest(_line_ids) x) then raise exception 'An order item no longer exists. Refresh Pending Orders.';end if;
 return result;
end $$;
notify pgrst,'reload schema';
commit;
