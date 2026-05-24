-- Reserve stock for paid eBay orders as soon as they are imported.
-- Physical stock is still removed only by the existing pending-order
-- fulfillment RPCs when the item is packed/shipped.

create table if not exists public.ebay_order_line_reservations (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.ebay_orders(id) on delete cascade,
  order_line_id uuid not null references public.ebay_order_lines(id) on delete cascade,
  item_id uuid not null references public.item_types(id) on delete cascade,
  stock_location_row_id uuid not null references public.item_stock_locations(id) on delete restrict,
  location_id uuid references public.locations(id) on delete set null,
  quantity integer not null check (quantity > 0),
  status text not null default 'reserved'
    check (status in ('reserved', 'fulfilled', 'released', 'cancelled')),
  source text not null default 'ebay_order_sync',
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_line_id)
);

create index if not exists ebay_order_line_reservations_active_idx
  on public.ebay_order_line_reservations(stock_location_row_id, status)
  where status = 'reserved';

create index if not exists ebay_order_line_reservations_item_status_idx
  on public.ebay_order_line_reservations(item_id, status, created_at desc);

alter table public.ebay_order_line_reservations enable row level security;

drop policy if exists "ebay_order_line_reservations_inventory_select"
on public.ebay_order_line_reservations;

create policy "ebay_order_line_reservations_inventory_select"
on public.ebay_order_line_reservations
for select
to authenticated
using (public.can_manage_inventory());

grant select on table public.ebay_order_line_reservations to authenticated;
grant select, insert, update, delete on table public.ebay_order_line_reservations to service_role;

create or replace function public.touch_ebay_order_line_reservation_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_ebay_order_line_reservations_updated_at
on public.ebay_order_line_reservations;

create trigger trg_ebay_order_line_reservations_updated_at
before update on public.ebay_order_line_reservations
for each row execute function public.touch_ebay_order_line_reservation_updated_at();

create or replace view public.active_stock_reservations as
select
  stock_location_row_id,
  location_id,
  item_id,
  sum(reserved_quantity)::integer as reserved_quantity,
  sum(reservation_count)::integer as reservation_count,
  min(first_reserved_at) as first_reserved_at,
  max(last_reserved_at) as last_reserved_at
from (
  select
    source_stock_location_row_id as stock_location_row_id,
    source_location_id as location_id,
    item_id,
    sum(quantity)::integer as reserved_quantity,
    count(*)::integer as reservation_count,
    min(scanned_at) as first_reserved_at,
    max(scanned_at) as last_reserved_at
  from public.live_sale_lot_items
  where status = 'reserved'
  group by source_stock_location_row_id, source_location_id, item_id

  union all

  select
    stock_location_row_id,
    location_id,
    item_id,
    sum(quantity)::integer as reserved_quantity,
    count(*)::integer as reservation_count,
    min(created_at) as first_reserved_at,
    max(created_at) as last_reserved_at
  from public.ebay_order_line_reservations
  where status = 'reserved'
  group by stock_location_row_id, location_id, item_id
) reservations
group by stock_location_row_id, location_id, item_id;

grant select on public.active_stock_reservations to authenticated;

create or replace function public.get_available_stock_after_reservations(_stock_row_id uuid)
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  select greatest(
    coalesce(isl.quantity, 0)
    - coalesce((
        select sum(r.reserved_quantity)::integer
        from public.active_stock_reservations r
        where r.stock_location_row_id = isl.id
      ), 0),
    0
  )
  from public.item_stock_locations isl
  where isl.id = _stock_row_id;
$$;

revoke all on function public.get_available_stock_after_reservations(uuid) from public;
grant execute on function public.get_available_stock_after_reservations(uuid) to authenticated;

create table if not exists public.ebay_order_sync_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed')),
  dry_run boolean not null default false,
  orders_seen integer not null default 0,
  orders_imported integer not null default 0,
  lines_imported integer not null default 0,
  lines_reserved integer not null default 0,
  warnings jsonb not null default '[]'::jsonb,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

alter table public.ebay_order_sync_runs enable row level security;

drop policy if exists "ebay_order_sync_runs_inventory_select"
on public.ebay_order_sync_runs;

create policy "ebay_order_sync_runs_inventory_select"
on public.ebay_order_sync_runs
for select
to authenticated
using (public.can_manage_inventory());

grant select on table public.ebay_order_sync_runs to authenticated;
grant select, insert, update on table public.ebay_order_sync_runs to service_role;

create or replace function public.close_ebay_order_line_reservation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.line_status in ('fulfilled', 'skipped') then
    update public.ebay_order_line_reservations
    set status = 'fulfilled',
        raw_payload = raw_payload || jsonb_build_object('closed_by_line_status', new.line_status, 'closed_at', now())
    where order_line_id = new.id
      and status = 'reserved';
  elsif new.line_status = 'cancelled' then
    update public.ebay_order_line_reservations
    set status = 'cancelled',
        raw_payload = raw_payload || jsonb_build_object('closed_by_line_status', new.line_status, 'closed_at', now())
    where order_line_id = new.id
      and status = 'reserved';
  end if;

  return new;
end;
$$;

drop trigger if exists ebay_order_lines_close_reservation
on public.ebay_order_lines;

create trigger ebay_order_lines_close_reservation
after update of line_status, fulfilled_quantity on public.ebay_order_lines
for each row execute function public.close_ebay_order_line_reservation();

create or replace function public.reserve_ebay_order_line_stock(_order_line_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text := coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), '');
  v_line public.ebay_order_lines;
  v_item_id uuid;
  v_needed integer;
  v_existing public.ebay_order_line_reservations;
  v_stock record;
begin
  if v_role <> 'service_role' and not public.can_manage_inventory() then
    raise exception 'Not allowed to reserve eBay order stock' using errcode = '42501';
  end if;

  select *
    into v_line
  from public.ebay_order_lines
  where id = _order_line_id
  for update;

  if not found then
    raise exception 'eBay order line not found' using errcode = 'P0002';
  end if;

  if v_line.line_status in ('fulfilled', 'cancelled', 'skipped') then
    update public.ebay_order_line_reservations
    set status = case when v_line.line_status = 'cancelled' then 'cancelled' else 'fulfilled' end
    where order_line_id = v_line.id
      and status = 'reserved';
    return jsonb_build_object('ok', true, 'status', 'closed', 'lineStatus', v_line.line_status);
  end if;

  v_needed := greatest(coalesce(v_line.quantity, 0) - coalesce(v_line.fulfilled_quantity, 0), 0);
  if v_needed <= 0 then
    update public.ebay_order_line_reservations
    set status = 'fulfilled'
    where order_line_id = v_line.id
      and status = 'reserved';
    return jsonb_build_object('ok', true, 'status', 'nothing_to_reserve');
  end if;

  v_item_id := v_line.internal_item_id;

  if v_item_id is null and nullif(btrim(coalesce(v_line.custom_label, '')), '') is not null then
    select id
      into v_item_id
    from public.item_types
    where nullif(btrim(barcode), '') = nullif(btrim(v_line.custom_label), '')
      and deleted_at is null
    limit 1;
  end if;

  if v_item_id is null then
    return jsonb_build_object(
      'ok', false,
      'status', 'unmatched',
      'reason', 'No item_types row matches this eBay line custom label/SKU.',
      'sku', v_line.custom_label
    );
  end if;

  select *
    into v_existing
  from public.ebay_order_line_reservations
  where order_line_id = v_line.id
    and status = 'reserved'
  limit 1;

  if found
     and v_existing.item_id = v_item_id
     and v_existing.quantity = v_needed then
    update public.ebay_order_lines
    set internal_item_id = v_item_id,
        stock_location_row_id = v_existing.stock_location_row_id,
        location_id = v_existing.location_id
    where id = v_line.id;

    return jsonb_build_object(
      'ok', true,
      'status', 'already_reserved',
      'itemId', v_item_id,
      'stockLocationRowId', v_existing.stock_location_row_id,
      'quantity', v_existing.quantity
    );
  end if;

  update public.ebay_order_line_reservations
  set status = 'released',
      raw_payload = raw_payload || jsonb_build_object('released_for_reallocation_at', now())
  where order_line_id = v_line.id
    and status = 'reserved';

  select
    isl.id,
    isl.item_id,
    isl.location_id,
    isl.quantity,
    public.get_available_stock_after_reservations(isl.id) as available_quantity
    into v_stock
  from public.item_stock_locations isl
  left join public.locations loc on loc.id = isl.location_id
  where isl.item_id = v_item_id
    and coalesce(isl.quantity, 0) > 0
    and public.get_available_stock_after_reservations(isl.id) >= v_needed
  order by
    case
      when coalesce(loc.is_tray, false) is true
        and coalesce(loc.tray_status, 'checked_in') <> 'checked_out'
      then 0
      else 1
    end,
    public.get_available_stock_after_reservations(isl.id) desc,
    isl.last_updated asc nulls last
  limit 1;

  if not found then
    update public.ebay_order_lines
    set internal_item_id = v_item_id
    where id = v_line.id;

    return jsonb_build_object(
      'ok', false,
      'status', 'no_available_stock',
      'itemId', v_item_id,
      'needed', v_needed
    );
  end if;

  insert into public.ebay_order_line_reservations (
    order_id,
    order_line_id,
    item_id,
    stock_location_row_id,
    location_id,
    quantity,
    status,
    raw_payload
  )
  values (
    v_line.order_id,
    v_line.id,
    v_item_id,
    v_stock.id,
    v_stock.location_id,
    v_needed,
    'reserved',
    jsonb_build_object(
      'custom_label', v_line.custom_label,
      'available_before_reservation', v_stock.available_quantity,
      'reserved_at', now()
    )
  )
  on conflict (order_line_id) do update
  set item_id = excluded.item_id,
      stock_location_row_id = excluded.stock_location_row_id,
      location_id = excluded.location_id,
      quantity = excluded.quantity,
      status = 'reserved',
      raw_payload = public.ebay_order_line_reservations.raw_payload || excluded.raw_payload;

  update public.ebay_order_lines
  set internal_item_id = v_item_id,
      stock_location_row_id = v_stock.id,
      location_id = v_stock.location_id
  where id = v_line.id;

  return jsonb_build_object(
    'ok', true,
    'status', 'reserved',
    'itemId', v_item_id,
    'stockLocationRowId', v_stock.id,
    'quantity', v_needed
  );
end;
$$;

revoke all on function public.reserve_ebay_order_line_stock(uuid) from public;
grant execute on function public.reserve_ebay_order_line_stock(uuid) to authenticated;
grant execute on function public.reserve_ebay_order_line_stock(uuid) to service_role;

create or replace function public.reserve_ebay_order_line_stock_from_line()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  if new.line_status in ('pending', 'partially_fulfilled') then
    perform public.reserve_ebay_order_line_stock(new.id);
  else
    update public.ebay_order_line_reservations
    set status = case when new.line_status = 'cancelled' then 'cancelled' else 'fulfilled' end,
        raw_payload = raw_payload || jsonb_build_object('closed_by_line_status', new.line_status, 'closed_at', now())
    where order_line_id = new.id
      and status = 'reserved';
  end if;

  return new;
end;
$$;

drop trigger if exists ebay_order_lines_auto_reserve_stock
on public.ebay_order_lines;

create trigger ebay_order_lines_auto_reserve_stock
after insert or update of custom_label, internal_item_id, quantity, line_status, fulfilled_quantity
on public.ebay_order_lines
for each row execute function public.reserve_ebay_order_line_stock_from_line();
