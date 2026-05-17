-- Atomic live-sale bag corrections.
-- Workers/admins can correct a mistaken auction-bag item before packing while
-- preserving the reservation trail and preventing over-reserving stock.

create or replace function public.correct_live_sale_lot_item_group(
  _lot_id uuid,
  _old_item_id uuid,
  _new_item_barcode text,
  _new_stock_location_row_id uuid,
  _quantity integer,
  _notes text,
  _signed_by_email text default null
)
returns table (
  lot_id uuid,
  old_item_id uuid,
  new_item_id uuid,
  quantity integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lot public.live_sale_lots;
  v_session public.live_sale_sessions;
  v_old_item public.item_types;
  v_new_item public.item_types;
  v_source public.item_stock_locations;
  v_location public.locations;
  v_qty integer := greatest(coalesce(_quantity, 0), 0);
  v_note text := nullif(btrim(coalesce(_notes, '')), '');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
  v_barcode text := regexp_replace(lower(btrim(coalesce(_new_item_barcode, ''))), '[\s-]+', '', 'g');
  v_old_quantity integer := 0;
  v_old_sources jsonb := '[]'::jsonb;
  v_reserved_other integer := 0;
  v_available integer := 0;
  v_elapsed integer;
  v_source_role text;
  v_is_tray boolean;
  v_source_store_id uuid;
  v_lot_item_id uuid;
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to correct live sale reservations' using errcode = '42501';
  end if;

  if v_note is null then
    raise exception 'A brief correction explanation is required' using errcode = '22023';
  end if;

  if v_barcode = '' then
    raise exception 'Scan the replacement item barcode first' using errcode = '22023';
  end if;

  if v_qty <= 0 then
    raise exception 'Replacement quantity must be greater than zero' using errcode = '22023';
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

  select it.*
    into v_old_item
  from public.item_types it
  where it.id = _old_item_id;

  if not found then
    raise exception 'Original live-sale item was not found' using errcode = 'P0002';
  end if;

  select
    coalesce(sum(li.quantity), 0)::integer,
    coalesce(
      min(li.show_elapsed_seconds),
      greatest(extract(epoch from (now() - v_session.started_at))::integer, 0)
    ),
    coalesce(jsonb_agg(jsonb_build_object(
      'lot_item_id', li.id,
      'source_stock_location_row_id', li.source_stock_location_row_id,
      'source_location_id', li.source_location_id,
      'source_location_name', l.location_name,
      'source_location_code', l.location_code,
      'quantity', li.quantity,
      'scanned_at', li.scanned_at,
      'show_elapsed_seconds', li.show_elapsed_seconds
    ) order by li.scanned_at), '[]'::jsonb)
    into v_old_quantity, v_elapsed, v_old_sources
  from public.live_sale_lot_items li
  left join public.locations l on l.id = li.source_location_id
  where li.lot_id = v_lot.id
    and li.item_id = _old_item_id
    and li.status = 'reserved';

  if coalesce(v_old_quantity, 0) <= 0 then
    raise exception 'No reserved units for that item were found in this auction bag' using errcode = 'P0002';
  end if;

  select it.*
    into v_new_item
  from public.item_types it
  where regexp_replace(lower(coalesce(it.barcode, '')), '[\s-]+', '', 'g') = v_barcode
    and it.deleted_at is null
  limit 1;

  if not found then
    select it.*
      into v_new_item
    from public.item_types it
    where regexp_replace(lower(coalesce(it.barcode, '')), '[\s-]+', '', 'g') = v_barcode
    limit 1;
  end if;

  if not found then
    raise exception 'No active inventory item matched the replacement barcode' using errcode = 'P0002';
  end if;

  select *
    into v_source
  from public.item_stock_locations
  where id = _new_stock_location_row_id
  for update;

  if not found then
    raise exception 'Replacement source stock row not found' using errcode = 'P0002';
  end if;

  if v_source.item_id is distinct from v_new_item.id then
    raise exception 'That source location does not hold the replacement item' using errcode = '22023';
  end if;

  select *
    into v_location
  from public.locations
  where id = v_source.location_id;

  if not found then
    raise exception 'Replacement source location was not found' using errcode = 'P0002';
  end if;

  v_source_role := coalesce(
    nullif(btrim(v_location.location_role), ''),
    case when coalesce(v_location.is_tray, false) then 'tray' else 'storage_location' end
  );
  v_is_tray := coalesce(v_location.is_tray, false) is true or v_source_role = 'tray';
  v_source_store_id := case
    when v_is_tray then coalesce(v_location.tray_current_store_id, v_location.store_id)
    else v_location.store_id
  end;

  if v_is_tray and coalesce(v_location.tray_status, 'checked_in') = 'checked_out' then
    raise exception 'That replacement tray is currently checked out' using errcode = '22023';
  end if;

  if not v_is_tray and v_source_role not in ('storage_location', 'container') then
    raise exception 'Replacement source must be a tray, storage location, or container' using errcode = '22023';
  end if;

  if v_session.store_id is not null
     and v_source_store_id is distinct from v_session.store_id then
    raise exception 'That replacement source is not in the active live-sale store' using errcode = '22023';
  end if;

  select coalesce(sum(li.quantity), 0)::integer
    into v_reserved_other
  from public.live_sale_lot_items li
  where li.source_stock_location_row_id = v_source.id
    and li.status = 'reserved'
    and not (
      li.lot_id = v_lot.id
      and li.item_id = _old_item_id
    );

  v_available := coalesce(v_source.quantity, 0) - coalesce(v_reserved_other, 0);
  if v_available < v_qty then
    raise exception 'Only % replacement unit(s) are available at that source', greatest(v_available, 0) using errcode = '22023';
  end if;

  update public.live_sale_lot_items li
  set status = 'released',
      notes = coalesce(li.notes || ' | ', '') || 'Corrected out of bag: ' || v_note
  where li.lot_id = v_lot.id
    and li.item_id = _old_item_id
    and li.status = 'reserved';

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
    v_new_item.id,
    v_source.id,
    v_source.location_id,
    v_qty,
    auth.uid(),
    v_signed_email,
    v_elapsed,
    'Correction replacement: ' || v_note
  )
  returning id into v_lot_item_id;

  update public.live_sale_lots
  set status = 'reserved',
      closed_at = null
  where id = v_lot.id
    and status in ('open', 'reserved', 'released');

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
    v_new_item.id,
    'bag_item_corrected',
    v_signed_email,
    v_note,
    jsonb_build_object(
      'action', 'item_replacement',
      'old_item_id', v_old_item.id,
      'old_item_title', v_old_item.title,
      'old_barcode', v_old_item.barcode,
      'old_quantity', v_old_quantity,
      'old_sources', v_old_sources,
      'new_item_id', v_new_item.id,
      'new_item_title', v_new_item.title,
      'new_barcode', v_new_item.barcode,
      'new_quantity', v_qty,
      'new_source_stock_location_row_id', v_source.id,
      'new_source_location_id', v_source.location_id,
      'new_source_location_name', v_location.location_name,
      'new_source_location_code', v_location.location_code,
      'new_source_role', v_source_role,
      'new_source_kind', case when v_is_tray then 'tray' else v_source_role end,
      'show_elapsed_seconds', v_elapsed
    )
  );

  lot_id := v_lot.id;
  old_item_id := v_old_item.id;
  new_item_id := v_new_item.id;
  quantity := v_qty;
  return next;
end;
$$;

revoke all on function public.correct_live_sale_lot_item_group(uuid, uuid, text, uuid, integer, text, text) from public;
grant execute on function public.correct_live_sale_lot_item_group(uuid, uuid, text, uuid, integer, text, text) to authenticated;
