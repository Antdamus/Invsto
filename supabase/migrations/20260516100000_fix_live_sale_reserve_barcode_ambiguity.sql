-- Qualify live-sale reservation columns so PL/pgSQL output names such as
-- "barcode" and "quantity" cannot collide with table columns.

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

  select it.*
    into v_item
  from public.item_types it
  where regexp_replace(lower(coalesce(it.barcode, '')), '[\s-]+', '', 'g') = v_barcode
    and it.deleted_at is null
  limit 1;

  if not found then
    select it.*
      into v_item
    from public.item_types it
    where regexp_replace(lower(coalesce(it.barcode, '')), '[\s-]+', '', 'g') = v_barcode
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

  select coalesce(sum(li.quantity), 0)::integer
    into v_reserved
  from public.live_sale_lot_items li
  where li.source_stock_location_row_id = v_source.id
    and li.status = 'reserved';

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
revoke all on function public.reserve_live_sale_item(uuid, text, uuid, integer, text, text) from public;
grant execute on function public.reserve_live_sale_item(uuid, text, uuid, integer, text, text) to authenticated;
