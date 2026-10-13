begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

-- Fully completed selected lines may enter Packaging while other lines remain
-- pending. Existing contents checks still forbid adding unfinished lines.
create or replace function public.packaging_order_ready(_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.packaging_handoffs h where h.order_id=_id)
 and exists(select 1 from public.ebay_order_lines l where l.order_id=_id and l.fulfilled_quantity>0 and l.line_status='fulfilled')
 and exists(select 1 from public.ebay_orders o where o.id=_id and o.status not in ('cancelled','archived'))
$$;

-- A partial shipment must not close the shipping assignment for the remaining
-- items. Keep the current RPC's permissions, evidence and inventory checks.
do $$ declare definition text; updated text; needle text; begin
 definition:=pg_get_functiondef('public.packaging_workspace(text,jsonb)'::regprocedure);
 needle:=$part$and t.task_type in ('pending_shipping','pending_packaging') and t.status not in ('shipped_completed','closed','cancelled','resolved')$part$;
 updated:=replace(definition,needle,needle||E'\n    and not exists(select 1 from public.ebay_order_lines pending where pending.order_id=t.order_id and pending.line_status in (''pending'',''partially_fulfilled''))');
 if updated=definition then raise exception 'Review packaging dispatch task completion before deploying';end if;
 execute updated;
end $$;

create or replace function public.packaging_guard_shipping_task() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.status='shipped_completed' and old.status is distinct from new.status and new.task_type in ('pending_shipping','pending_packaging')
 and exists(select 1 from public.packaging_handoffs where order_id=new.order_id)
 and (exists(select 1 from public.ebay_order_lines l where l.order_id=new.order_id and l.line_status in ('pending','partially_fulfilled'))
 or not exists(select 1 from public.packaging_shipments where new.order_id=any(order_ids) and status='dispatched')
 or exists(select 1 from public.ebay_order_lines l where l.order_id=new.order_id and l.line_status not in ('cancelled','skipped') and l.fulfilled_quantity>coalesce((select sum(i.quantity) from public.packaging_items i join public.packaging_shipments p on p.id=i.shipment_id where i.order_line_id=l.id and p.status='dispatched'),0))) then
  raise exception 'Complete packing and dispatch for every remaining item before closing this shipping task';
 end if;
 return new;
end $$;

notify pgrst,'reload schema';
commit;
