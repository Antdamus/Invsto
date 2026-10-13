begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

-- Missing watches hold their own lines. Other processing holds still apply to
-- the buyer's bundle; selecting another line never releases or resolves a hold.
create function public.assert_pending_work_scope_clear(_order_ids uuid[],_line_ids uuid[]) returns void
language plpgsql security definer set search_path='' as $$
declare b public.pending_order_work_blockers;
begin
 select x.* into b from public.pending_order_work_blockers x
 where x.buyer_key in (select public.pending_work_buyer_key(id) from public.ebay_orders where id=any(_order_ids))
 and x.released_at is null and public.pending_work_blocker_active(x)
 and exists(select 1 from public.pending_order_work_blocker_lines bl join public.ebay_order_lines l on l.id=bl.order_line_id
  where bl.blocker_id=x.id and l.line_status in ('pending','partially_fulfilled')
   and (x.kind<>'watch_missing' or
    case when _line_ids is null then l.order_id=any(_order_ids) else l.id=any(_line_ids) end))
 order by x.created_at,x.id limit 1;
 if found then
  if b.kind='watch_missing' then
   raise exception 'Watch missing: leave this item unselected to ship the available items, or mark the watch found after checking it.' using errcode='23514';
  end if;
  raise exception 'Package is waiting: %. Resolve its blocker before completing this buyer''s items.',b.reason using errcode='23514';
 end if;
end $$;

create or replace function public.assert_pending_work_clear(_order_ids uuid[]) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform public.assert_pending_work_scope_clear(_order_ids,null);
end $$;

create or replace function public.guard_pending_work_completion() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is not null then
  if tg_table_name='ebay_order_lines' then
   if (new.line_status='fulfilled' and old.line_status is distinct from new.line_status) or new.fulfilled_quantity>coalesce(old.fulfilled_quantity,0)
   then perform public.assert_pending_work_scope_clear(array[new.order_id],array[new.id]);end if;
  elsif new.status='fulfilled' and old.status is distinct from new.status then perform public.assert_pending_work_clear(array[new.id]);end if;
 end if;
 return new;
end $$;

create or replace function public.guard_packaging_cgl_requirement() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.status in ('ready','dispatched') and (tg_op='INSERT' or new.status is distinct from old.status) then
  if exists(select 1 from public.pending_order_work_blockers b
   join public.pending_order_work_blocker_lines bl on bl.blocker_id=b.id
   join public.ebay_order_lines l on l.id=bl.order_line_id
   where l.order_id=any(new.order_ids) and b.kind='pending_cancel' and public.pending_work_blocker_active(b))
  then raise exception 'Pending to cancel: complete the cancellation or clear the marker before dispatch.' using errcode='23514';end if;
  if exists(select 1 from public.pending_order_work_blockers b
   join public.pending_order_work_blocker_lines bl on bl.blocker_id=b.id
   join public.ebay_order_lines l on l.id=bl.order_line_id
   where l.order_id=any(new.order_ids) and b.kind='watch_missing' and public.pending_work_blocker_active(b)
   and (not exists(select 1 from public.packaging_items i where i.shipment_id=new.id)
    or exists(select 1 from public.packaging_items i where i.shipment_id=new.id and i.order_line_id=l.id)))
  then raise exception 'Watch missing: locate and check the watch before dispatch.' using errcode='23514';end if;
  if exists(select 1 from public.pending_order_work_blockers b
   join public.pending_order_work_blocker_lines bl on bl.blocker_id=b.id
   join public.ebay_order_lines l on l.id=bl.order_line_id
   where l.order_id=any(new.order_ids) and b.kind='cgl' and public.pending_work_blocker_active(b))
  then raise exception 'Pending CGL: a required certificate is missing or marked incorrect. Confirm the correct certificate before dispatch.' using errcode='23514';end if;
 end if;
 return new;
end $$;

revoke all on function public.assert_pending_work_scope_clear(uuid[],uuid[]) from public,anon,authenticated;
notify pgrst,'reload schema';
commit;
