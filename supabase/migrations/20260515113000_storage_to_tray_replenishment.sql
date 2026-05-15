-- Worker storage-to-tray replenishment.
-- Moves stock from a bag/container under a fixed location into a mobile tray,
-- while preventing the same item from being active in another tray in that store.

create or replace function public.transfer_container_stock_to_tray(
  _source_stock_row_id uuid,
  _destination_tray_location_id uuid,
  _quantity integer,
  _signed_by_email text default null,
  _notes text default null
)
returns table (
  item_id uuid,
  source_stock_row_id uuid,
  destination_stock_row_id uuid,
  source_location_id uuid,
  destination_location_id uuid,
  transferred_quantity integer,
  source_remaining integer,
  destination_quantity integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source public.item_stock_locations;
  v_source_location public.locations;
  v_parent_location public.locations;
  v_tray public.locations;
  v_item public.item_types;
  v_dest public.item_stock_locations;
  v_qty integer := coalesce(_quantity, 0);
  v_now timestamptz := now();
  v_source_store_id uuid;
  v_tray_store_id uuid;
  v_conflict record;
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
  v_note text := nullif(btrim(coalesce(_notes, '')), '');
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to transfer inventory' using errcode = '42501';
  end if;

  if _source_stock_row_id is null or _destination_tray_location_id is null then
    raise exception 'Source bag stock and destination tray are required' using errcode = '22023';
  end if;

  if v_qty <= 0 then
    raise exception 'Quantity must be greater than zero' using errcode = '22023';
  end if;

  select *
    into v_source
  from public.item_stock_locations
  where id = _source_stock_row_id
  for update;

  if not found then
    raise exception 'Source stock row not found' using errcode = 'P0002';
  end if;

  if v_source.locked_by is not null and v_source.locked_by is distinct from auth.uid() then
    raise exception 'This source bag is locked by another user' using errcode = '55P03';
  end if;

  if coalesce(v_source.quantity, 0) < v_qty then
    raise exception 'Only % units are available in the selected bag', coalesce(v_source.quantity, 0) using errcode = '22023';
  end if;

  select *
    into v_source_location
  from public.locations
  where id = v_source.location_id
  for update;

  if not found then
    raise exception 'Source bag location not found' using errcode = 'P0002';
  end if;

  if coalesce(v_source_location.is_tray, false) is true
     or coalesce(v_source_location.location_role, '') <> 'container'
     or v_source_location.parent_location_id is null then
    raise exception 'Source must be a bag or container inside a parent location' using errcode = '22023';
  end if;

  select *
    into v_parent_location
  from public.locations
  where id = v_source_location.parent_location_id;

  if not found then
    raise exception 'Parent table, vault, or storage location was not found' using errcode = 'P0002';
  end if;

  select *
    into v_tray
  from public.locations
  where id = _destination_tray_location_id
  for update;

  if not found then
    raise exception 'Destination tray not found' using errcode = 'P0002';
  end if;

  if coalesce(v_tray.is_tray, false) is distinct from true
     and coalesce(v_tray.location_role, '') <> 'tray' then
    raise exception 'Destination must be a mobile tray' using errcode = '22023';
  end if;

  if v_source_location.active is false or v_parent_location.active is false or v_tray.active is false then
    raise exception 'Source location, parent location, and destination tray must all be active' using errcode = '22023';
  end if;

  v_source_store_id := coalesce(v_parent_location.store_id, v_source_location.store_id);
  v_tray_store_id := coalesce(v_tray.tray_current_store_id, v_tray.store_id);

  if v_source_store_id is null or v_tray_store_id is null or v_source_store_id is distinct from v_tray_store_id then
    raise exception 'The destination tray must be checked into the same store as the source bag' using errcode = '22023';
  end if;

  select *
    into v_item
  from public.item_types
  where id = v_source.item_id;

  if not found then
    raise exception 'Inventory item not found' using errcode = 'P0002';
  end if;

  select l.location_name, l.location_code
    into v_conflict
  from public.item_stock_locations isl
  join public.locations l on l.id = isl.location_id
  where isl.item_id = v_source.item_id
    and coalesce(isl.quantity, 0) > 0
    and l.id <> v_tray.id
    and (
      coalesce(l.is_tray, false) is true
      or coalesce(l.location_role, '') = 'tray'
    )
    and coalesce(l.tray_current_store_id, l.store_id) is not distinct from v_tray_store_id
  order by l.location_name
  limit 1;

  if found then
    raise exception 'This item is already in tray % (%) in this store',
      coalesce(v_conflict.location_name, 'Unknown tray'),
      coalesce(v_conflict.location_code, 'no barcode')
      using errcode = '23505';
  end if;

  update public.item_stock_locations
  set quantity = coalesce(v_source.quantity, 0) - v_qty,
      last_updated = v_now,
      added_by = auth.uid(),
      confirmation_email = coalesce(v_signed_email, confirmation_email),
      confirmation_method = 'storage_to_tray_transfer',
      confirmed_at = v_now,
      locked_by = null,
      locked_at = null
  where id = v_source.id
  returning * into v_source;

  select *
    into v_dest
  from public.item_stock_locations isl
  where isl.item_id = v_source.item_id
    and isl.location_id = v_tray.id
  for update;

  if found then
    update public.item_stock_locations
    set quantity = coalesce(v_dest.quantity, 0) + v_qty,
        last_updated = v_now,
        added_by = auth.uid(),
        confirmation_email = coalesce(v_signed_email, confirmation_email),
        confirmation_method = 'storage_to_tray_transfer',
        confirmed_at = v_now
    where id = v_dest.id
    returning * into v_dest;
  else
    insert into public.item_stock_locations (
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
      v_source.item_id,
      v_tray.id,
      v_qty,
      auth.uid(),
      v_signed_email,
      'storage_to_tray_transfer',
      v_now,
      v_now
    )
    returning * into v_dest;
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
    method,
    timestamp
  )
  values
    (
      v_source.item_id,
      v_source.location_id,
      -v_qty,
      'transfer',
      v_now,
      auth.uid(),
      v_signed_email,
      'Moved from container ' || coalesce(v_source_location.location_name, v_source_location.location_code) ||
        ' to tray ' || coalesce(v_tray.location_name, v_tray.location_code) ||
        coalesce(' - ' || v_note, ''),
      'storage_to_tray_transfer',
      v_now
    ),
    (
      v_source.item_id,
      v_tray.id,
      v_qty,
      'transfer',
      v_now,
      auth.uid(),
      v_signed_email,
      'Received from container ' || coalesce(v_source_location.location_name, v_source_location.location_code) ||
        ' under ' || coalesce(v_parent_location.location_name, v_parent_location.location_code) ||
        coalesce(' - ' || v_note, ''),
      'storage_to_tray_transfer',
      v_now
    );

  item_id := v_source.item_id;
  source_stock_row_id := v_source.id;
  destination_stock_row_id := v_dest.id;
  source_location_id := v_source.location_id;
  destination_location_id := v_tray.id;
  transferred_quantity := v_qty;
  source_remaining := v_source.quantity;
  destination_quantity := v_dest.quantity;
  return next;
end;
$$;

revoke all on function public.transfer_container_stock_to_tray(uuid, uuid, integer, text, text) from public;
grant execute on function public.transfer_container_stock_to_tray(uuid, uuid, integer, text, text) to authenticated;
