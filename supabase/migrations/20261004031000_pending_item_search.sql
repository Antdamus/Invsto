-- A shared, per-item flag independent of fulfillment, imported data, and written notes.
create table public.pending_order_item_search (
  order_line_id uuid primary key references public.ebay_order_lines(id) on delete cascade,
  is_missing boolean not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  updated_by_email text not null
);
create table public.pending_order_item_search_events (
  id uuid primary key default gen_random_uuid(),
  order_line_id uuid not null references public.ebay_order_lines(id) on delete cascade,
  is_missing boolean not null,
  created_at timestamptz not null default now(),
  signed_by uuid references auth.users(id) on delete set null,
  signed_by_email text not null
);
create index on public.pending_order_item_search_events(order_line_id,created_at desc);
alter table public.pending_order_item_search enable row level security;
alter table public.pending_order_item_search_events enable row level security;
revoke all on public.pending_order_item_search,public.pending_order_item_search_events from anon,authenticated;
grant select on public.pending_order_item_search,public.pending_order_item_search_events to authenticated;
create policy "Staff read item searches" on public.pending_order_item_search for select to authenticated
  using(public.can_manage_inventory());
create policy "Staff read item search history" on public.pending_order_item_search_events for select to authenticated
  using(public.can_manage_inventory());

create function public.set_pending_order_item_missing(_order_line_id uuid,_is_missing boolean)
returns public.pending_order_item_search language plpgsql security definer set search_path=public,pg_temp as $$
declare l public.ebay_order_lines; result public.pending_order_item_search; actor text;
begin
  if not public.can_manage_inventory() then raise exception 'Staff required' using errcode='42501'; end if;
  if _is_missing is null then raise exception 'Missing item status required' using errcode='22023'; end if;
  select * into l from public.ebay_order_lines where id=_order_line_id for update;
  if not found then raise exception 'Order item not found' using errcode='P0002'; end if;
  if _is_missing and l.line_status not in ('pending','partially_fulfilled') then
    raise exception 'This item is no longer pending. Refresh the order.' using errcode='22023';
  end if;
  select * into result from public.pending_order_item_search where order_line_id=l.id;
  if found and result.is_missing=_is_missing then return result; end if;
  select coalesce(email,'Staff') into actor from auth.users where id=auth.uid();
  insert into public.pending_order_item_search(order_line_id,is_missing,updated_by,updated_by_email)
    values(l.id,_is_missing,auth.uid(),coalesce(actor,'Staff'))
    on conflict(order_line_id) do update set is_missing=excluded.is_missing,updated_at=clock_timestamp(),
      updated_by=excluded.updated_by,updated_by_email=excluded.updated_by_email returning * into result;
  insert into public.pending_order_item_search_events(order_line_id,is_missing,signed_by,signed_by_email)
    values(l.id,_is_missing,auth.uid(),coalesce(actor,'Staff'));
  begin
    perform realtime.send(jsonb_build_object('kind','item_search','line_id',l.id),'changed','pending-orders:updates',true);
  exception when others then raise warning 'Item search notification unavailable: %',sqlstate;
  end;
  return result;
end $$;
revoke all on function public.set_pending_order_item_missing(uuid,boolean) from public,anon;
grant execute on function public.set_pending_order_item_missing(uuid,boolean) to authenticated;

create or replace function public.list_pending_ebay_order_queue_v2(
  _status text default 'pending', _include_admin_fields boolean default false,
  _limit integer default 1000, _offset integer default 0
) returns setof jsonb language sql stable security definer set search_path=public,pg_temp as $$
  select to_jsonb(q) || jsonb_build_object(
    'line_raw_payload',coalesce(l.raw_payload,'{}'::jsonb),
    'order_raw_payload',coalesce(o.raw_payload,'{}'::jsonb),
    'item_search',to_jsonb(s))
  from public.list_pending_ebay_order_queue(_status,_include_admin_fields,_limit,_offset) q
  join public.ebay_order_lines l on l.id=q.id
  join public.ebay_orders o on o.id=q.order_id
  left join public.pending_order_item_search s on s.order_line_id=l.id;
$$;
