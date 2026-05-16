-- Live-sale reserved stock layer.
-- Sellers scan items into an auction bag/box during the show. Those items are
-- reserved immediately, but physical stock is removed only when the bag is
-- matched to a pending eBay order and confirmed by packing staff.

create table if not exists public.live_sale_sessions (
  id uuid primary key default gen_random_uuid(),
  session_code text not null unique default (
    'LS-' || to_char(now(), 'YYYYMMDD-HH24MISS') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 4))
  ),
  title text not null default 'Live Sale',
  store_id uuid references public.store_locations(id) on delete set null,
  status text not null default 'active'
    check (status in ('active', 'ended', 'cancelled')),
  started_by uuid references auth.users(id) on delete set null default auth.uid(),
  started_by_email text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.live_sale_lots (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.live_sale_sessions(id) on delete cascade,
  auction_number text not null,
  lot_code text not null unique default (
    'LIVE-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))
  ),
  label_path text,
  status text not null default 'open'
    check (status in ('open', 'reserved', 'packed', 'cancelled', 'released')),
  matched_order_id uuid references public.ebay_orders(id) on delete set null,
  matched_order_line_id uuid references public.ebay_order_lines(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_by_email text,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  notes text,
  unique (session_id, auction_number)
);

create table if not exists public.live_sale_lot_items (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references public.live_sale_lots(id) on delete cascade,
  session_id uuid not null references public.live_sale_sessions(id) on delete cascade,
  item_id uuid not null references public.item_types(id) on delete cascade,
  source_stock_location_row_id uuid not null references public.item_stock_locations(id) on delete restrict,
  source_location_id uuid not null references public.locations(id) on delete restrict,
  quantity integer not null default 1 check (quantity > 0),
  status text not null default 'reserved'
    check (status in ('reserved', 'packed', 'released', 'cancelled', 'reverted')),
  scanned_by uuid references auth.users(id) on delete set null default auth.uid(),
  scanned_by_email text,
  scanned_at timestamptz not null default now(),
  show_elapsed_seconds integer,
  packed_order_line_id uuid references public.ebay_order_lines(id) on delete set null,
  packed_sale_item_id uuid references public.sale_items(id) on delete set null,
  packed_stock_transaction_id uuid references public.stock_transactions(id) on delete set null,
  packed_at timestamptz,
  notes text
);

create table if not exists public.live_sale_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references public.live_sale_sessions(id) on delete set null,
  lot_id uuid references public.live_sale_lots(id) on delete set null,
  lot_item_id uuid references public.live_sale_lot_items(id) on delete set null,
  item_id uuid references public.item_types(id) on delete set null,
  event_type text not null,
  actor uuid references auth.users(id) on delete set null default auth.uid(),
  actor_email text,
  notes text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists live_sale_sessions_status_idx
  on public.live_sale_sessions(status, started_at desc);

create index if not exists live_sale_lots_session_status_idx
  on public.live_sale_lots(session_id, status, created_at desc);

create index if not exists live_sale_lots_auction_number_idx
  on public.live_sale_lots(auction_number);

create index if not exists live_sale_lot_items_reserved_stock_idx
  on public.live_sale_lot_items(source_stock_location_row_id, status)
  where status = 'reserved';

create index if not exists live_sale_lot_items_item_status_idx
  on public.live_sale_lot_items(item_id, status, scanned_at desc);

create index if not exists live_sale_lot_items_order_line_idx
  on public.live_sale_lot_items(packed_order_line_id)
  where packed_order_line_id is not null;

alter table public.live_sale_sessions enable row level security;
alter table public.live_sale_lots enable row level security;
alter table public.live_sale_lot_items enable row level security;
alter table public.live_sale_events enable row level security;

drop policy if exists "live_sale_sessions_inventory_select" on public.live_sale_sessions;
create policy "live_sale_sessions_inventory_select"
on public.live_sale_sessions
for select
to authenticated
using (public.can_manage_inventory());

drop policy if exists "live_sale_sessions_inventory_write" on public.live_sale_sessions;
create policy "live_sale_sessions_inventory_write"
on public.live_sale_sessions
for all
to authenticated
using (public.can_manage_inventory())
with check (public.can_manage_inventory());

drop policy if exists "live_sale_lots_inventory_select" on public.live_sale_lots;
create policy "live_sale_lots_inventory_select"
on public.live_sale_lots
for select
to authenticated
using (public.can_manage_inventory());

drop policy if exists "live_sale_lots_inventory_write" on public.live_sale_lots;
create policy "live_sale_lots_inventory_write"
on public.live_sale_lots
for all
to authenticated
using (public.can_manage_inventory())
with check (public.can_manage_inventory());

drop policy if exists "live_sale_lot_items_inventory_select" on public.live_sale_lot_items;
create policy "live_sale_lot_items_inventory_select"
on public.live_sale_lot_items
for select
to authenticated
using (public.can_manage_inventory());

drop policy if exists "live_sale_lot_items_inventory_write" on public.live_sale_lot_items;
create policy "live_sale_lot_items_inventory_write"
on public.live_sale_lot_items
for all
to authenticated
using (public.can_manage_inventory())
with check (public.can_manage_inventory());

drop policy if exists "live_sale_events_inventory_select" on public.live_sale_events;
create policy "live_sale_events_inventory_select"
on public.live_sale_events
for select
to authenticated
using (public.can_manage_inventory());

drop policy if exists "live_sale_events_inventory_insert" on public.live_sale_events;
create policy "live_sale_events_inventory_insert"
on public.live_sale_events
for insert
to authenticated
with check (public.can_manage_inventory());

grant select, insert, update on table public.live_sale_sessions to authenticated;
grant select, insert, update on table public.live_sale_lots to authenticated;
grant select, insert, update on table public.live_sale_lot_items to authenticated;
grant select, insert on table public.live_sale_events to authenticated;

create or replace function public.touch_live_sale_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_live_sale_sessions_updated_at on public.live_sale_sessions;
create trigger trg_live_sale_sessions_updated_at
before update on public.live_sale_sessions
for each row execute function public.touch_live_sale_updated_at();

create or replace function public.get_available_stock_after_reservations(_stock_row_id uuid)
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  select greatest(
    coalesce(isl.quantity, 0)
    - coalesce((
        select sum(li.quantity)::integer
        from public.live_sale_lot_items li
        where li.source_stock_location_row_id = isl.id
          and li.status = 'reserved'
      ), 0),
    0
  )
  from public.item_stock_locations isl
  where isl.id = _stock_row_id;
$$;

create or replace view public.active_stock_reservations as
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
group by source_stock_location_row_id, source_location_id, item_id;

grant select on public.active_stock_reservations to authenticated;

create or replace function public.start_live_sale_session(
  _title text default null,
  _store_id uuid default null,
  _notes text default null,
  _signed_by_email text default null
)
returns public.live_sale_sessions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.live_sale_sessions;
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to start live sale sessions' using errcode = '42501';
  end if;

  if _store_id is not null and not exists (
    select 1 from public.store_locations where id = _store_id and active is true
  ) then
    raise exception 'Selected store is not active' using errcode = '22023';
  end if;

  insert into public.live_sale_sessions (
    title,
    store_id,
    started_by,
    started_by_email,
    notes
  )
  values (
    coalesce(nullif(btrim(_title), ''), 'Live Sale'),
    _store_id,
    auth.uid(),
    nullif(btrim(coalesce(_signed_by_email, '')), ''),
    nullif(btrim(coalesce(_notes, '')), '')
  )
  returning * into v_session;

  insert into public.live_sale_events (
    session_id,
    event_type,
    actor_email,
    notes,
    payload
  )
  values (
    v_session.id,
    'session_started',
    nullif(btrim(coalesce(_signed_by_email, '')), ''),
    nullif(btrim(coalesce(_notes, '')), ''),
    jsonb_build_object('store_id', _store_id, 'title', v_session.title)
  );

  return v_session;
end;
$$;

create or replace function public.end_live_sale_session(
  _session_id uuid,
  _notes text default null,
  _signed_by_email text default null
)
returns public.live_sale_sessions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.live_sale_sessions;
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to end live sale sessions' using errcode = '42501';
  end if;

  update public.live_sale_sessions
  set status = 'ended',
      ended_at = now(),
      notes = coalesce(nullif(btrim(coalesce(_notes, '')), ''), notes)
  where id = _session_id
    and status = 'active'
  returning * into v_session;

  if not found then
    raise exception 'Active live sale session not found' using errcode = 'P0002';
  end if;

  insert into public.live_sale_events (
    session_id,
    event_type,
    actor_email,
    notes
  )
  values (
    v_session.id,
    'session_ended',
    nullif(btrim(coalesce(_signed_by_email, '')), ''),
    nullif(btrim(coalesce(_notes, '')), '')
  );

  return v_session;
end;
$$;

create or replace function public.create_live_sale_lot(
  _session_id uuid,
  _auction_number text,
  _notes text default null,
  _signed_by_email text default null
)
returns public.live_sale_lots
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.live_sale_sessions;
  v_lot public.live_sale_lots;
  v_auction text := nullif(btrim(coalesce(_auction_number, '')), '');
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to create live sale lots' using errcode = '42501';
  end if;

  if v_auction is null then
    raise exception 'Auction number is required' using errcode = '22023';
  end if;

  select *
    into v_session
  from public.live_sale_sessions
  where id = _session_id
    and status = 'active';

  if not found then
    raise exception 'Active live sale session not found' using errcode = 'P0002';
  end if;

  insert into public.live_sale_lots (
    session_id,
    auction_number,
    created_by,
    created_by_email,
    notes
  )
  values (
    v_session.id,
    v_auction,
    auth.uid(),
    nullif(btrim(coalesce(_signed_by_email, '')), ''),
    nullif(btrim(coalesce(_notes, '')), '')
  )
  on conflict (session_id, auction_number) do update
    set notes = coalesce(excluded.notes, public.live_sale_lots.notes)
  returning * into v_lot;

  insert into public.live_sale_events (
    session_id,
    lot_id,
    event_type,
    actor_email,
    notes,
    payload
  )
  values (
    v_session.id,
    v_lot.id,
    'lot_created',
    nullif(btrim(coalesce(_signed_by_email, '')), ''),
    nullif(btrim(coalesce(_notes, '')), ''),
    jsonb_build_object('auction_number', v_lot.auction_number, 'lot_code', v_lot.lot_code)
  );

  return v_lot;
end;
$$;

create or replace function public.set_live_sale_lot_label(
  _lot_id uuid,
  _label_path text,
  _signed_by_email text default null
)
returns public.live_sale_lots
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lot public.live_sale_lots;
  v_path text := nullif(btrim(coalesce(_label_path, '')), '');
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to update live sale labels' using errcode = '42501';
  end if;

  if v_path is null then
    raise exception 'Label path is required' using errcode = '22023';
  end if;

  update public.live_sale_lots
  set label_path = v_path
  where id = _lot_id
  returning * into v_lot;

  if not found then
    raise exception 'Live sale lot not found' using errcode = 'P0002';
  end if;

  insert into public.live_sale_events (
    session_id,
    lot_id,
    event_type,
    actor_email,
    payload
  )
  values (
    v_lot.session_id,
    v_lot.id,
    'lot_label_generated',
    nullif(btrim(coalesce(_signed_by_email, '')), ''),
    jsonb_build_object('label_path', v_path)
  );

  return v_lot;
end;
$$;

create or replace function public.reserve_live_sale_item(
  _lot_id uuid,
  _item_barcode text,
  _stock_location_row_id uuid default null,
  _quantity integer default 1,
  _signed_by_email text default null,
  _notes text default null
)
returns table (
  lot_item_id uuid,
  lot_id uuid,
  item_id uuid,
  title text,
  barcode text,
  source_stock_location_row_id uuid,
  source_location_id uuid,
  source_location_name text,
  source_location_code text,
  quantity integer,
  remaining_available integer,
  show_elapsed_seconds integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lot public.live_sale_lots;
  v_session public.live_sale_sessions;
  v_item public.item_types;
  v_source public.item_stock_locations;
  v_location public.locations;
  v_qty integer := coalesce(_quantity, 1);
  v_reserved integer := 0;
  v_available integer := 0;
  v_barcode text := regexp_replace(lower(btrim(coalesce(_item_barcode, ''))), '[\s-]+', '', 'g');
  v_elapsed integer;
  v_lot_item_id uuid;
  v_source_count integer;
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to reserve live sale inventory' using errcode = '42501';
  end if;

  if v_barcode = '' then
    raise exception 'Scan an item barcode first' using errcode = '22023';
  end if;

  if v_qty <= 0 then
    raise exception 'Quantity must be greater than zero' using errcode = '22023';
  end if;

  select *
    into v_lot
  from public.live_sale_lots
  where id = _lot_id
    and status in ('open', 'reserved')
  for update;

  if not found then
    raise exception 'Open live sale lot not found' using errcode = 'P0002';
  end if;

  select *
    into v_session
  from public.live_sale_sessions
  where id = v_lot.session_id
    and status = 'active';

  if not found then
    raise exception 'The live sale session is not active' using errcode = '22023';
  end if;

  select *
    into v_item
  from public.item_types
  where regexp_replace(lower(coalesce(barcode, '')), '[\s-]+', '', 'g') = v_barcode
    and deleted_at is null
  limit 1;

  if not found then
    select *
      into v_item
    from public.item_types
    where regexp_replace(lower(coalesce(barcode, '')), '[\s-]+', '', 'g') = v_barcode
    limit 1;
  end if;

  if not found then
    raise exception 'No active inventory item matched that barcode' using errcode = 'P0002';
  end if;

  if _stock_location_row_id is null then
    select count(*)
      into v_source_count
    from public.item_stock_locations isl
    join public.locations l on l.id = isl.location_id
    where isl.item_id = v_item.id
      and coalesce(isl.quantity, 0) > 0
      and (
        v_session.store_id is null
        or coalesce(l.tray_current_store_id, l.store_id) is not distinct from v_session.store_id
      )
      and (
        coalesce(l.is_tray, false) is true
        or coalesce(l.location_role, '') = 'tray'
      )
      and coalesce(l.tray_status, 'checked_in') <> 'checked_out'
      and public.get_available_stock_after_reservations(isl.id) >= v_qty;

    if v_source_count = 0 then
      raise exception 'No available checked-in tray stock can be reserved for this item' using errcode = '22023';
    end if;

    if v_source_count > 1 then
      raise exception 'Multiple source trays hold this item; choose the exact source tray' using errcode = '22023';
    end if;

    select isl.*
      into v_source
    from public.item_stock_locations isl
    join public.locations l on l.id = isl.location_id
    where isl.item_id = v_item.id
      and coalesce(isl.quantity, 0) > 0
      and (
        v_session.store_id is null
        or coalesce(l.tray_current_store_id, l.store_id) is not distinct from v_session.store_id
      )
      and (
        coalesce(l.is_tray, false) is true
        or coalesce(l.location_role, '') = 'tray'
      )
      and coalesce(l.tray_status, 'checked_in') <> 'checked_out'
      and public.get_available_stock_after_reservations(isl.id) >= v_qty
    limit 1
    for update;
  else
    select *
      into v_source
    from public.item_stock_locations
    where id = _stock_location_row_id
    for update;
  end if;

  if not found then
    raise exception 'Source stock row not found' using errcode = 'P0002';
  end if;

  if v_source.item_id is distinct from v_item.id then
    raise exception 'That source location does not hold the scanned item' using errcode = '22023';
  end if;

  select *
    into v_location
  from public.locations
  where id = v_source.location_id;

  if not found then
    raise exception 'Source location was not found' using errcode = 'P0002';
  end if;

  if coalesce(v_location.is_tray, false) is distinct from true
     and coalesce(v_location.location_role, '') <> 'tray' then
    raise exception 'Live-sale reservations must come from a tray' using errcode = '22023';
  end if;

  if coalesce(v_location.tray_status, 'checked_in') = 'checked_out' then
    raise exception 'That source tray is currently checked out' using errcode = '22023';
  end if;

  if v_session.store_id is not null
     and coalesce(v_location.tray_current_store_id, v_location.store_id) is distinct from v_session.store_id then
    raise exception 'That source is not in the active live-sale store' using errcode = '22023';
  end if;

  select coalesce(sum(quantity), 0)::integer
    into v_reserved
  from public.live_sale_lot_items
  where source_stock_location_row_id = v_source.id
    and status = 'reserved';

  v_available := coalesce(v_source.quantity, 0) - coalesce(v_reserved, 0);
  if v_available < v_qty then
    raise exception 'Only % unreserved unit(s) are available at that source', greatest(v_available, 0) using errcode = '22023';
  end if;

  v_elapsed := greatest(extract(epoch from (now() - v_session.started_at))::integer, 0);

  insert into public.live_sale_lot_items (
    lot_id,
    session_id,
    item_id,
    source_stock_location_row_id,
    source_location_id,
    quantity,
    scanned_by,
    scanned_by_email,
    show_elapsed_seconds,
    notes
  )
  values (
    v_lot.id,
    v_session.id,
    v_item.id,
    v_source.id,
    v_source.location_id,
    v_qty,
    auth.uid(),
    nullif(btrim(coalesce(_signed_by_email, '')), ''),
    v_elapsed,
    nullif(btrim(coalesce(_notes, '')), '')
  )
  returning id into v_lot_item_id;

  update public.live_sale_lots
  set status = 'reserved'
  where id = v_lot.id
    and status = 'open';

  insert into public.live_sale_events (
    session_id,
    lot_id,
    lot_item_id,
    item_id,
    event_type,
    actor_email,
    notes,
    payload
  )
  values (
    v_session.id,
    v_lot.id,
    v_lot_item_id,
    v_item.id,
    'item_reserved',
    nullif(btrim(coalesce(_signed_by_email, '')), ''),
    nullif(btrim(coalesce(_notes, '')), ''),
    jsonb_build_object(
      'barcode', v_item.barcode,
      'quantity', v_qty,
      'source_stock_location_row_id', v_source.id,
      'source_location_id', v_source.location_id,
      'show_elapsed_seconds', v_elapsed
    )
  );

  lot_item_id := v_lot_item_id;
  lot_id := v_lot.id;
  item_id := v_item.id;
  title := v_item.title;
  barcode := v_item.barcode;
  source_stock_location_row_id := v_source.id;
  source_location_id := v_source.location_id;
  source_location_name := v_location.location_name;
  source_location_code := v_location.location_code;
  quantity := v_qty;
  remaining_available := greatest(v_available - v_qty, 0);
  show_elapsed_seconds := v_elapsed;
  return next;
end;
$$;

create or replace function public.release_live_sale_lot_item(
  _lot_item_id uuid,
  _notes text default null,
  _signed_by_email text default null
)
returns public.live_sale_lot_items
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lot_item public.live_sale_lot_items;
  v_note text := nullif(btrim(coalesce(_notes, '')), '');
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to release live sale reservations' using errcode = '42501';
  end if;

  update public.live_sale_lot_items
  set status = 'released',
      notes = coalesce(v_note, notes)
  where id = _lot_item_id
    and status = 'reserved'
  returning * into v_lot_item;

  if not found then
    raise exception 'Reserved live sale item not found' using errcode = 'P0002';
  end if;

  if not exists (
    select 1
    from public.live_sale_lot_items
    where lot_id = v_lot_item.lot_id
      and status = 'reserved'
  ) then
    update public.live_sale_lots
    set status = 'released',
        closed_at = now()
    where id = v_lot_item.lot_id
      and status in ('open', 'reserved');
  end if;

  insert into public.live_sale_events (
    session_id,
    lot_id,
    lot_item_id,
    item_id,
    event_type,
    actor_email,
    notes
  )
  values (
    v_lot_item.session_id,
    v_lot_item.lot_id,
    v_lot_item.id,
    v_lot_item.item_id,
    'item_released',
    nullif(btrim(coalesce(_signed_by_email, '')), ''),
    v_note
  );

  return v_lot_item;
end;
$$;

create or replace function public.cancel_live_sale_lot(
  _lot_id uuid,
  _notes text,
  _signed_by_email text default null
)
returns public.live_sale_lots
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lot public.live_sale_lots;
  v_note text := nullif(btrim(coalesce(_notes, '')), '');
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to cancel live sale lots' using errcode = '42501';
  end if;

  if v_note is null then
    raise exception 'A note is required to cancel a live sale bag' using errcode = '22023';
  end if;

  update public.live_sale_lot_items
  set status = 'cancelled',
      notes = coalesce(notes || ' | ', '') || v_note
  where lot_id = _lot_id
    and status = 'reserved';

  update public.live_sale_lots
  set status = 'cancelled',
      closed_at = now(),
      notes = coalesce(notes || ' | ', '') || v_note
  where id = _lot_id
    and status in ('open', 'reserved')
  returning * into v_lot;

  if not found then
    raise exception 'Open live sale lot not found' using errcode = 'P0002';
  end if;

  insert into public.live_sale_events (
    session_id,
    lot_id,
    event_type,
    actor_email,
    notes
  )
  values (
    v_lot.session_id,
    v_lot.id,
    'lot_cancelled',
    nullif(btrim(coalesce(_signed_by_email, '')), ''),
    v_note
  );

  return v_lot;
end;
$$;

create or replace function public.fulfill_ebay_order_line_with_live_lot(
  _order_line_id uuid,
  _lot_id uuid,
  _notes text default null,
  _signed_by_email text default null,
  _checkout_store_id uuid default null
)
returns table (
  order_id uuid,
  order_line_id uuid,
  sale_id uuid,
  packed_items integer,
  removed_units integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_line public.ebay_order_lines;
  v_order public.ebay_orders;
  v_lot public.live_sale_lots;
  v_sale_id uuid;
  v_sale_item_id uuid;
  v_tx_id uuid;
  v_first_item_id uuid;
  v_first_stock_row_id uuid;
  v_first_location_id uuid;
  v_first_sale_item_id uuid;
  v_first_tx_id uuid;
  v_line_total numeric(12,2);
  v_net_payout numeric(12,2);
  v_fee_amount numeric(12,2);
  v_fee_percent numeric(7,4);
  v_total_units integer;
  v_item_count integer := 0;
  v_removed_units integer := 0;
  v_now timestamptz := now();
  v_notes text := nullif(btrim(coalesce(_notes, '')), '');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
  v_order_status text;
  v_cart_snapshot jsonb := '[]'::jsonb;
  v_lot_item record;
  v_stock public.item_stock_locations;
  v_item public.item_types;
  v_location public.locations;
  v_remaining integer;
  v_alloc_total numeric(12,2);
  v_alloc_unit numeric(12,2);
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to fulfill eBay orders' using errcode = '42501';
  end if;

  if _order_line_id is null or _lot_id is null then
    raise exception 'Order line and live-sale bag are required' using errcode = '22023';
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
    raise exception 'This eBay order line is already closed' using errcode = '23505';
  end if;

  select *
    into v_order
  from public.ebay_orders
  where id = v_line.order_id
  for update;

  if not found then
    raise exception 'eBay order not found' using errcode = 'P0002';
  end if;

  select *
    into v_lot
  from public.live_sale_lots
  where id = _lot_id
    and status in ('open', 'reserved')
  for update;

  if not found then
    raise exception 'Open live sale bag not found' using errcode = 'P0002';
  end if;

  select coalesce(sum(quantity), 0)::integer,
         count(*)::integer
    into v_total_units, v_item_count
  from public.live_sale_lot_items
  where lot_id = v_lot.id
    and status = 'reserved';

  if coalesce(v_total_units, 0) <= 0 then
    raise exception 'That live sale bag has no reserved items to pack' using errcode = '22023';
  end if;

  v_line_total := coalesce(nullif(v_line.total_price, 0), nullif(v_line.sold_for, 0), 0);
  v_net_payout := coalesce(
    v_line.net_payout,
    case
      when coalesce(v_line.total_price, 0) > 0 and coalesce(v_order.total_price, 0) > 0
        then greatest(round(
          v_line.total_price
          - (coalesce(v_order.ebay_collected_tax, 0) * (v_line.total_price / v_order.total_price))
          - (coalesce(v_order.ebay_collected_charges, 0) * (v_line.total_price / v_order.total_price))
          - (coalesce(v_order.seller_collected_tax, 0) * (v_line.total_price / v_order.total_price)),
          2
        ), 0)
      when coalesce(v_line.total_price, 0) > 0 then v_line.total_price
      else null
    end,
    case
      when coalesce(v_order.net_payout, 0) > 0 and coalesce(v_order.total_price, 0) > 0
        then round(v_order.net_payout * (coalesce(nullif(v_line.total_price, 0), v_line_total) / v_order.total_price), 2)
      else null
    end,
    v_line_total
  );
  v_fee_amount := greatest(round(v_line_total - v_net_payout, 2), 0);
  v_fee_percent := case when v_line_total > 0 then round((v_fee_amount / v_line_total) * 100, 4) else 0 end;

  select s.id
    into v_sale_id
  from public.sales s
  where s.platform = 'ebay'
    and s.external_sales_id = v_order.order_number
  order by s.created_at desc
  limit 1;

  if v_sale_id is null then
    insert into public.sales (
      external_sales_id,
      user_id,
      email,
      platform,
      subtotal,
      credits_applied,
      total_discount,
      final_amount,
      platform_fee_amount,
      platform_fee_percent,
      profit_amount,
      flagged,
      verified_method,
      verified_at,
      created_at
    )
    values (
      v_order.order_number,
      auth.uid(),
      v_signed_email,
      'ebay',
      coalesce(nullif(v_order.total_price, 0), v_line_total),
      0,
      0,
      coalesce(nullif(v_order.total_price, 0), v_line_total),
      v_fee_amount,
      v_fee_percent,
      v_net_payout,
      false,
      'authenticated_session',
      v_now,
      v_now
    )
    returning id into v_sale_id;
  end if;

  for v_lot_item in
    select *
    from public.live_sale_lot_items
    where lot_id = v_lot.id
      and status = 'reserved'
    order by scanned_at, id
  loop
    select *
      into v_stock
    from public.item_stock_locations
    where id = v_lot_item.source_stock_location_row_id
    for update;

    if not found then
      raise exception 'Source stock row for reserved bag item was not found' using errcode = 'P0002';
    end if;

    if coalesce(v_stock.quantity, 0) < v_lot_item.quantity then
      raise exception 'Only % physical unit(s) remain for a reserved item', coalesce(v_stock.quantity, 0) using errcode = '22023';
    end if;

    select *
      into v_location
    from public.locations
    where id = v_stock.location_id;

    if _checkout_store_id is not null then
      if not (
        coalesce(v_location.is_tray, false) is true
        or coalesce(v_location.location_role, '') = 'tray'
      ) then
        raise exception 'Live-sale eBay checkout must come from tray stock' using errcode = '22023';
      end if;

      if coalesce(v_location.tray_status, 'checked_in') = 'checked_out' then
        raise exception 'That source tray is checked out and cannot be used for packing' using errcode = '22023';
      end if;

      if coalesce(v_location.tray_current_store_id, v_location.store_id) is distinct from _checkout_store_id then
        raise exception 'The reserved source tray is not checked into the selected checkout store' using errcode = '22023';
      end if;
    end if;

    select *
      into v_item
    from public.item_types
    where id = v_lot_item.item_id;

    if not found then
      raise exception 'Reserved inventory item was not found' using errcode = 'P0002';
    end if;

    v_alloc_total := case
      when v_line_total > 0 then round(v_line_total * (v_lot_item.quantity::numeric / greatest(v_total_units, 1)), 2)
      else round(coalesce(v_item.sale_price, 0) * v_lot_item.quantity, 2)
    end;
    v_alloc_unit := case
      when v_lot_item.quantity > 0 then round(v_alloc_total / v_lot_item.quantity, 2)
      else 0
    end;

    update public.item_stock_locations
    set quantity = coalesce(quantity, 0) - v_lot_item.quantity,
        last_updated = v_now,
        locked_by = null,
        locked_at = null
    where id = v_stock.id
    returning quantity into v_remaining;

    insert into public.sale_items (
      sale_id,
      item_id,
      title,
      quantity,
      sale_price,
      discount_percent,
      discount_amount,
      final_price,
      remaining_stock_qty,
      location_id,
      photo_path
    )
    values (
      v_sale_id,
      v_item.id,
      v_item.title,
      v_lot_item.quantity,
      v_alloc_unit,
      0,
      0,
      v_alloc_total,
      v_remaining,
      v_stock.location_id,
      coalesce((v_item.photos)[1], '')
    )
    returning id into v_sale_item_id;

    insert into public.sale_item_categories (sale_item_id, category)
    select v_sale_item_id, category
    from unnest(coalesce(v_item.categories, '{}'::text[])) as category;

    insert into public.stock_transactions (
      item_id,
      location_id,
      quantity,
      action_type,
      confirmed_at,
      user_id,
      email,
      notes,
      method,
      timestamp
    )
    values (
      v_item.id,
      v_stock.location_id,
      -v_lot_item.quantity,
      'checkout',
      v_now,
      auth.uid(),
      v_signed_email,
      'Live-sale bag ' || v_lot.lot_code || ' / auction ' || v_lot.auction_number ||
        ' packed for eBay order ' || coalesce(v_order.order_number, v_order.id::text) ||
        coalesce(' - ' || v_notes, ''),
      'live_sale_bag_checkout',
      v_now
    )
    returning id into v_tx_id;

    update public.live_sale_lot_items
    set status = 'packed',
        packed_order_line_id = v_line.id,
        packed_sale_item_id = v_sale_item_id,
        packed_stock_transaction_id = v_tx_id,
        packed_at = v_now
    where id = v_lot_item.id;

    if v_first_item_id is null then
      v_first_item_id := v_item.id;
      v_first_stock_row_id := v_stock.id;
      v_first_location_id := v_stock.location_id;
      v_first_sale_item_id := v_sale_item_id;
      v_first_tx_id := v_tx_id;
    end if;

    v_removed_units := v_removed_units + v_lot_item.quantity;
    v_cart_snapshot := v_cart_snapshot || jsonb_build_array(jsonb_build_object(
      'ebay_order_number', v_order.order_number,
      'ebay_item_number', v_line.item_number,
      'ebay_transaction_id', v_line.transaction_id,
      'ebay_buyer_username', v_order.buyer_username,
      'live_sale_session_id', v_lot.session_id,
      'live_sale_lot_id', v_lot.id,
      'auction_number', v_lot.auction_number,
      'lot_code', v_lot.lot_code,
      'lot_item_id', v_lot_item.id,
      'item_id', v_item.id,
      'title', v_item.title,
      'barcode', v_item.barcode,
      'quantity', v_lot_item.quantity,
      'allocated_sale_price', v_alloc_unit,
      'allocated_total', v_alloc_total,
      'source_stock_row_id', v_stock.id,
      'location_id', v_stock.location_id,
      'show_elapsed_seconds', v_lot_item.show_elapsed_seconds
    ));
  end loop;

  insert into public.sales_audit (
    external_sales_id,
    subtotal,
    credits_applied,
    owes_after_credit,
    per_item_discount,
    general_discount,
    effective_discount_pct,
    owes_store,
    platform_fee_amount,
    platform_fee_percent,
    profit_amount,
    platform,
    cart_snapshot,
    flagged,
    notes,
    verified_method,
    verified_at,
    created_at,
    email,
    user_id,
    credits_breakdown
  )
  values (
    v_order.order_number,
    v_line_total,
    0,
    v_line_total,
    0,
    0,
    0,
    v_line_total,
    v_fee_amount,
    v_fee_percent,
    v_net_payout,
    'ebay',
    v_cart_snapshot,
    false,
    coalesce(v_notes, 'Worker fulfilled pending eBay order from live-sale bag'),
    'authenticated_session',
    v_now,
    v_now,
    v_signed_email,
    auth.uid(),
    '[]'::jsonb
  );

  update public.live_sale_lots
  set status = 'packed',
      closed_at = v_now,
      matched_order_id = v_order.id,
      matched_order_line_id = v_line.id
  where id = v_lot.id;

  update public.ebay_order_lines
  set line_status = 'fulfilled',
      internal_item_id = v_first_item_id,
      stock_location_row_id = v_first_stock_row_id,
      location_id = v_first_location_id,
      fulfilled_quantity = quantity,
      fulfilled_by = auth.uid(),
      fulfilled_by_email = v_signed_email,
      fulfilled_at = v_now,
      sale_id = v_sale_id,
      sale_item_id = v_first_sale_item_id,
      stock_transaction_id = v_first_tx_id,
      notes = coalesce(v_notes || ' | ', '') || 'Packed from live-sale bag ' || v_lot.lot_code || ' / auction ' || v_lot.auction_number
  where id = v_line.id;

  v_order_status := case
    when not exists (
      select 1
      from public.ebay_order_lines l
      where l.order_id = v_order.id
        and l.line_status not in ('fulfilled', 'cancelled', 'skipped')
    ) then 'fulfilled'
    when exists (
      select 1
      from public.ebay_order_lines l
      where l.order_id = v_order.id
        and l.line_status in ('fulfilled', 'partially_fulfilled')
    ) then 'partially_fulfilled'
    else 'pending'
  end;

  update public.ebay_orders
  set status = v_order_status
  where id = v_order.id;

  insert into public.live_sale_events (
    session_id,
    lot_id,
    event_type,
    actor_email,
    notes,
    payload
  )
  values (
    v_lot.session_id,
    v_lot.id,
    'lot_packed_for_order',
    v_signed_email,
    v_notes,
    jsonb_build_object(
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'order_line_id', v_line.id,
      'packed_items', v_item_count,
      'removed_units', v_removed_units
    )
  );

  order_id := v_order.id;
  order_line_id := v_line.id;
  sale_id := v_sale_id;
  packed_items := v_item_count;
  removed_units := v_removed_units;
  return next;
end;
$$;

revoke all on function public.start_live_sale_session(text, uuid, text, text) from public;
revoke all on function public.end_live_sale_session(uuid, text, text) from public;
revoke all on function public.create_live_sale_lot(uuid, text, text, text) from public;
revoke all on function public.set_live_sale_lot_label(uuid, text, text) from public;
revoke all on function public.reserve_live_sale_item(uuid, text, uuid, integer, text, text) from public;
revoke all on function public.release_live_sale_lot_item(uuid, text, text) from public;
revoke all on function public.cancel_live_sale_lot(uuid, text, text) from public;
revoke all on function public.fulfill_ebay_order_line_with_live_lot(uuid, uuid, text, text, uuid) from public;
revoke all on function public.get_available_stock_after_reservations(uuid) from public;

grant execute on function public.start_live_sale_session(text, uuid, text, text) to authenticated;
grant execute on function public.end_live_sale_session(uuid, text, text) to authenticated;
grant execute on function public.create_live_sale_lot(uuid, text, text, text) to authenticated;
grant execute on function public.set_live_sale_lot_label(uuid, text, text) to authenticated;
grant execute on function public.reserve_live_sale_item(uuid, text, uuid, integer, text, text) to authenticated;
grant execute on function public.release_live_sale_lot_item(uuid, text, text) to authenticated;
grant execute on function public.cancel_live_sale_lot(uuid, text, text) to authenticated;
grant execute on function public.fulfill_ebay_order_line_with_live_lot(uuid, uuid, text, text, uuid) to authenticated;
grant execute on function public.get_available_stock_after_reservations(uuid) to authenticated;

-- Keep the existing admin order-history revert button safe for live-sale bags.
-- A live-sale bag can remove several internal inventory rows for one eBay line,
-- so the revert routine must restore every packed lot item, not only the first
-- stock_transaction_id stored on ebay_order_lines.
create or replace function public.admin_revert_ebay_order_lines(
  _order_line_ids uuid[],
  _notes text,
  _signed_by_email text default null
)
returns table (
  reverted_lines integer,
  restored_units integer,
  updated_orders integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_line_id uuid;
  v_line public.ebay_order_lines;
  v_stock public.item_stock_locations;
  v_order public.ebay_orders;
  v_note text := nullif(btrim(coalesce(_notes, '')), '');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
  v_now timestamptz := now();
  v_qty integer;
  v_order_ids uuid[] := '{}'::uuid[];
  v_reverted_line_ids uuid[] := '{}'::uuid[];
  v_order_id uuid;
  v_order_status text;
  v_reverted_lines integer := 0;
  v_restored_units integer := 0;
  v_updated_orders integer := 0;
  v_snapshots jsonb := '[]'::jsonb;
  v_found_stock boolean;
  v_live_item record;
  v_live_units integer;
begin
  if not public.is_admin() then
    raise exception 'Only admins can revert eBay order fulfillment' using errcode = '42501';
  end if;

  if coalesce(array_length(_order_line_ids, 1), 0) = 0 then
    raise exception 'Select at least one eBay order line to revert' using errcode = '22023';
  end if;

  if v_note is null then
    raise exception 'A note is required to revert an eBay order' using errcode = '22023';
  end if;

  foreach v_line_id in array _order_line_ids loop
    select *
      into v_line
    from public.ebay_order_lines
    where id = v_line_id
    for update;

    if not found then
      continue;
    end if;

    if v_line.line_status not in ('fulfilled', 'partially_fulfilled', 'cancelled', 'skipped') then
      continue;
    end if;

    select *
      into v_order
    from public.ebay_orders
    where id = v_line.order_id
    for update;

    v_qty := greatest(coalesce(v_line.fulfilled_quantity, 0), 0);
    v_live_units := 0;

    v_snapshots := v_snapshots || jsonb_build_array(jsonb_build_object(
      'order_id', v_line.order_id,
      'order_number', v_order.order_number,
      'order_line_id', v_line.id,
      'item_title', v_line.item_title,
      'item_number', v_line.item_number,
      'previous_status', v_line.line_status,
      'fulfilled_quantity', v_line.fulfilled_quantity,
      'fulfilled_by_email', v_line.fulfilled_by_email,
      'fulfilled_at', v_line.fulfilled_at,
      'internal_item_id', v_line.internal_item_id,
      'stock_location_row_id', v_line.stock_location_row_id,
      'location_id', v_line.location_id,
      'sale_id', v_line.sale_id,
      'sale_item_id', v_line.sale_item_id,
      'stock_transaction_id', v_line.stock_transaction_id,
      'notes', v_line.notes,
      'live_sale_lot_items', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'lot_item_id', li.id,
          'lot_id', li.lot_id,
          'item_id', li.item_id,
          'source_stock_location_row_id', li.source_stock_location_row_id,
          'source_location_id', li.source_location_id,
          'quantity', li.quantity,
          'packed_stock_transaction_id', li.packed_stock_transaction_id
        )), '[]'::jsonb)
        from public.live_sale_lot_items li
        where li.packed_order_line_id = v_line.id
          and li.status = 'packed'
      )
    ));

    for v_live_item in
      select li.*, ll.auction_number, ll.lot_code
      from public.live_sale_lot_items li
      join public.live_sale_lots ll on ll.id = li.lot_id
      where li.packed_order_line_id = v_line.id
        and li.status = 'packed'
      for update of li
    loop
      v_found_stock := false;
      select *
        into v_stock
      from public.item_stock_locations
      where id = v_live_item.source_stock_location_row_id
      for update;
      v_found_stock := found;

      if v_found_stock then
        update public.item_stock_locations
        set quantity = coalesce(quantity, 0) + v_live_item.quantity,
            last_updated = v_now,
            locked_by = null,
            locked_at = null
        where id = v_stock.id;
      else
        insert into public.item_stock_locations (
          id,
          item_id,
          location_id,
          quantity,
          added_by,
          confirmation_email,
          confirmation_method,
          confirmed_at,
          last_updated
        )
        values (
          v_live_item.source_stock_location_row_id,
          v_live_item.item_id,
          v_live_item.source_location_id,
          v_live_item.quantity,
          auth.uid(),
          v_signed_email,
          'admin_live_sale_order_revert',
          v_now,
          v_now
        );
      end if;

      insert into public.stock_transactions (
        item_id,
        location_id,
        quantity,
        action_type,
        confirmed_at,
        user_id,
        email,
        notes,
        source_transaction_id,
        method,
        timestamp
      )
      values (
        v_live_item.item_id,
        v_live_item.source_location_id,
        v_live_item.quantity,
        'correction',
        v_now,
        auth.uid(),
        v_signed_email,
        'Admin reverted live-sale bag ' || coalesce(v_live_item.lot_code, v_live_item.lot_id::text) ||
          ' / auction ' || coalesce(v_live_item.auction_number, '-') ||
          ' for eBay order ' || coalesce(v_order.order_number, v_line.order_id::text) || ' - ' || v_note,
        v_live_item.packed_stock_transaction_id,
        'admin_live_sale_order_revert',
        v_now
      );

      update public.live_sale_lot_items
      set status = 'reserved',
          packed_order_line_id = null,
          packed_sale_item_id = null,
          packed_stock_transaction_id = null,
          packed_at = null,
          notes = coalesce(notes || ' | ', '') || 'Admin reverted order: ' || v_note
      where id = v_live_item.id;

      update public.live_sale_lots
      set status = 'reserved',
          closed_at = null,
          matched_order_id = null,
          matched_order_line_id = null
      where id = v_live_item.lot_id;

      insert into public.live_sale_events (
        session_id,
        lot_id,
        lot_item_id,
        item_id,
        event_type,
        actor_email,
        notes,
        payload
      )
      values (
        v_live_item.session_id,
        v_live_item.lot_id,
        v_live_item.id,
        v_live_item.item_id,
        'packed_item_reverted',
        v_signed_email,
        v_note,
        jsonb_build_object(
          'order_line_id', v_line.id,
          'order_number', v_order.order_number,
          'quantity_restored', v_live_item.quantity
        )
      );

      v_live_units := v_live_units + v_live_item.quantity;
      v_restored_units := v_restored_units + v_live_item.quantity;
    end loop;

    if v_live_units = 0 and v_qty > 0 and v_line.internal_item_id is not null and v_line.location_id is not null then
      v_found_stock := false;
      if v_line.stock_location_row_id is not null then
        select *
          into v_stock
        from public.item_stock_locations
        where id = v_line.stock_location_row_id
        for update;
        v_found_stock := found;
      end if;

      if v_found_stock then
        update public.item_stock_locations
        set quantity = coalesce(quantity, 0) + v_qty,
            last_updated = v_now,
            locked_by = null,
            locked_at = null
        where id = v_stock.id;
      else
        insert into public.item_stock_locations (
          id,
          item_id,
          location_id,
          quantity,
          added_by,
          confirmation_email,
          confirmation_method,
          confirmed_at,
          last_updated
        )
        values (
          coalesce(v_line.stock_location_row_id, gen_random_uuid()),
          v_line.internal_item_id,
          v_line.location_id,
          v_qty,
          auth.uid(),
          v_signed_email,
          'admin_ebay_order_revert',
          v_now,
          v_now
        );
      end if;

      insert into public.stock_transactions (
        item_id,
        location_id,
        quantity,
        action_type,
        confirmed_at,
        user_id,
        email,
        notes,
        source_transaction_id,
        method,
        timestamp
      )
      values (
        v_line.internal_item_id,
        v_line.location_id,
        v_qty,
        'correction',
        v_now,
        auth.uid(),
        v_signed_email,
        'Admin reverted eBay order ' || coalesce(v_order.order_number, v_line.order_id::text) || ' - ' || v_note,
        v_line.stock_transaction_id,
        'admin_ebay_order_revert',
        v_now
      );

      v_restored_units := v_restored_units + v_qty;
    end if;

    update public.ebay_order_lines
    set line_status = 'pending',
        fulfilled_quantity = 0,
        fulfilled_by = null,
        fulfilled_by_email = null,
        fulfilled_at = null,
        internal_item_id = null,
        stock_location_row_id = null,
        location_id = null,
        sale_id = null,
        sale_item_id = null,
        stock_transaction_id = null,
        notes = 'Admin reverted: ' || v_note
    where id = v_line.id;

    v_reverted_lines := v_reverted_lines + 1;
    v_reverted_line_ids := array_append(v_reverted_line_ids, v_line.id);
    if not (v_line.order_id = any(v_order_ids)) then
      v_order_ids := array_append(v_order_ids, v_line.order_id);
    end if;
  end loop;

  if v_reverted_lines = 0 then
    raise exception 'No closed eBay order lines were reverted' using errcode = '22023';
  end if;

  foreach v_order_id in array v_order_ids loop
    select case
      when not exists (
        select 1
        from public.ebay_order_lines l
        where l.order_id = v_order_id
          and l.line_status not in ('fulfilled', 'cancelled', 'skipped')
      ) then
        case
          when exists (
            select 1
            from public.ebay_order_lines l
            where l.order_id = v_order_id
              and l.line_status = 'fulfilled'
          ) then 'fulfilled'
          else 'cancelled'
        end
      when exists (
        select 1
        from public.ebay_order_lines l
        where l.order_id = v_order_id
          and l.line_status in ('fulfilled', 'partially_fulfilled')
      ) then 'partially_fulfilled'
      else 'pending'
    end
    into v_order_status;

    update public.ebay_orders
    set status = v_order_status
    where id = v_order_id;

    v_updated_orders := v_updated_orders + 1;
  end loop;

  insert into public.ebay_order_revert_events (
    order_ids,
    order_line_ids,
    notes,
    signed_by,
    signed_by_email,
    payload
  )
  values (
    v_order_ids,
    v_reverted_line_ids,
    v_note,
    auth.uid(),
    v_signed_email,
    jsonb_build_object(
      'reverted_lines', v_reverted_lines,
      'restored_units', v_restored_units,
      'updated_orders', v_updated_orders,
      'reverted_at', v_now,
      'line_snapshots', v_snapshots
    )
  );

  reverted_lines := v_reverted_lines;
  restored_units := v_restored_units;
  updated_orders := v_updated_orders;
  return next;
end;
$$;

revoke all on function public.admin_revert_ebay_order_lines(uuid[], text, text) from public;
grant execute on function public.admin_revert_ebay_order_lines(uuid[], text, text) to authenticated;
