-- Let the live-sale manifest manage one visible quantity per item/source pair.
-- This keeps the seller UI fast while preserving reservation and audit history.

create or replace function public.set_live_sale_lot_group_quantity(
  _lot_id uuid,
  _item_id uuid,
  _stock_location_row_id uuid,
  _quantity integer,
  _signed_by_email text default null,
  _notes text default null
)
returns table (
  lot_id uuid,
  item_id uuid,
  source_stock_location_row_id uuid,
  quantity integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lot public.live_sale_lots;
  v_session public.live_sale_sessions;
  v_source public.item_stock_locations;
  v_location public.locations;
  v_target integer := greatest(coalesce(_quantity, 0), 0);
  v_current integer := 0;
  v_capacity integer := 0;
  v_elapsed integer;
  v_note text := nullif(btrim(coalesce(_notes, '')), '');
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to adjust live sale reservations' using errcode = '42501';
  end if;

  select *
    into v_lot
  from public.live_sale_lots
  where id = _lot_id
    and status in ('open', 'reserved', 'released')
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
    into v_source
  from public.item_stock_locations
  where id = _stock_location_row_id
  for update;

  if not found then
    raise exception 'Source stock row not found' using errcode = 'P0002';
  end if;

  if v_source.item_id is distinct from _item_id then
    raise exception 'That source location does not hold the selected item' using errcode = '22023';
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

  select
    coalesce(sum(li.quantity), 0)::integer,
    coalesce(min(li.show_elapsed_seconds), greatest(extract(epoch from (now() - v_session.started_at))::integer, 0))
    into v_current, v_elapsed
  from public.live_sale_lot_items li
  where li.lot_id = v_lot.id
    and li.item_id = _item_id
    and li.source_stock_location_row_id = _stock_location_row_id
    and li.status = 'reserved';

  v_capacity := public.get_available_stock_after_reservations(_stock_location_row_id) + v_current;
  if v_target > v_capacity then
    raise exception 'Only % unit(s) are available for this item/source', greatest(v_capacity, 0) using errcode = '22023';
  end if;

  update public.live_sale_lot_items li
  set status = 'released',
      notes = coalesce(v_note, li.notes)
  where li.lot_id = v_lot.id
    and li.item_id = _item_id
    and li.source_stock_location_row_id = _stock_location_row_id
    and li.status = 'reserved';

  if v_target > 0 then
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
      _item_id,
      v_source.id,
      v_source.location_id,
      v_target,
      auth.uid(),
      nullif(btrim(coalesce(_signed_by_email, '')), ''),
      v_elapsed,
      v_note
    );

    update public.live_sale_lots
    set status = 'reserved',
        closed_at = null
    where id = v_lot.id
      and status in ('open', 'reserved', 'released');
  elsif not exists (
    select 1
    from public.live_sale_lot_items li
    where li.lot_id = v_lot.id
      and li.status = 'reserved'
  ) then
    update public.live_sale_lots
    set status = 'released',
        closed_at = now()
    where id = v_lot.id
      and status in ('open', 'reserved', 'released');
  end if;

  insert into public.live_sale_events (
    session_id,
    lot_id,
    item_id,
    event_type,
    actor_email,
    notes,
    payload
  )
  values (
    v_session.id,
    v_lot.id,
    _item_id,
    'lot_item_quantity_set',
    nullif(btrim(coalesce(_signed_by_email, '')), ''),
    v_note,
    jsonb_build_object(
      'source_stock_location_row_id', _stock_location_row_id,
      'source_location_id', v_source.location_id,
      'previous_quantity', v_current,
      'new_quantity', v_target
    )
  );

  lot_id := v_lot.id;
  item_id := _item_id;
  source_stock_location_row_id := _stock_location_row_id;
  quantity := v_target;
  return next;
end;
$$;
revoke all on function public.set_live_sale_lot_group_quantity(uuid, uuid, uuid, integer, text, text) from public;
grant execute on function public.set_live_sale_lot_group_quantity(uuid, uuid, uuid, integer, text, text) to authenticated;
