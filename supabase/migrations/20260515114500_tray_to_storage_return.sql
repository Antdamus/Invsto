-- Worker tray-to-storage return flow.
-- Moves stock from a mobile tray back into a specific bag/container under a
-- specific parent location, requiring both destination labels to match.

create or replace function public.transfer_tray_stock_to_container(
  _source_stock_row_id uuid,
  _destination_container_location_id uuid,
  _parent_location_id uuid,
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
  v_source_tray public.locations;
  v_dest_container public.locations;
  v_parent public.locations;
  v_dest public.item_stock_locations;
  v_item public.item_types;
  v_qty integer := coalesce(_quantity, 0);
  v_now timestamptz := now();
  v_source_store_id uuid;
  v_dest_store_id uuid;
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
  v_note text := nullif(btrim(coalesce(_notes, '')), '');
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to transfer inventory' using errcode = '42501';
  end if;

  if _source_stock_row_id is null or _destination_container_location_id is null or _parent_location_id is null then
    raise exception 'Source tray stock, destination bag, and parent location are required' using errcode = '22023';
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
    raise exception 'Source tray stock row not found' using errcode = 'P0002';
  end if;

  if v_source.locked_by is not null and v_source.locked_by is distinct from auth.uid() then
    raise exception 'This tray stock row is locked by another user' using errcode = '55P03';
  end if;

  if coalesce(v_source.quantity, 0) < v_qty then
    raise exception 'Only % units are available in the selected tray', coalesce(v_source.quantity, 0) using errcode = '22023';
  end if;

  select *
    into v_source_tray
  from public.locations
  where id = v_source.location_id
  for update;

  if not found then
    raise exception 'Source tray location not found' using errcode = 'P0002';
  end if;

  if coalesce(v_source_tray.is_tray, false) is distinct from true
     and coalesce(v_source_tray.location_role, '') <> 'tray' then
    raise exception 'Source must be a mobile tray' using errcode = '22023';
  end if;

  select *
    into v_dest_container
  from public.locations
  where id = _destination_container_location_id
  for update;

  if not found then
    raise exception 'Destination bag/container not found' using errcode = 'P0002';
  end if;

  if coalesce(v_dest_container.is_tray, false) is true
     or coalesce(v_dest_container.location_role, '') <> 'container'
     or v_dest_container.parent_location_id is null then
    raise exception 'Destination must be a bag or container inside a parent location' using errcode = '22023';
  end if;

  if v_dest_container.parent_location_id is distinct from _parent_location_id then
    raise exception 'The scanned bag does not belong to the scanned parent location' using errcode = '22023';
  end if;

  select *
    into v_parent
  from public.locations
  where id = _parent_location_id
  for update;

  if not found then
    raise exception 'Parent table, vault, or storage location not found' using errcode = 'P0002';
  end if;

  if v_source_tray.active is false or v_dest_container.active is false or v_parent.active is false then
    raise exception 'Source tray, destination bag, and parent location must all be active' using errcode = '22023';
  end if;

  v_source_store_id := coalesce(v_source_tray.tray_current_store_id, v_source_tray.store_id);
  v_dest_store_id := coalesce(v_parent.store_id, v_dest_container.store_id);

  if v_source_store_id is null or v_dest_store_id is null or v_source_store_id is distinct from v_dest_store_id then
    raise exception 'The destination bag must be in the same store as the source tray' using errcode = '22023';
  end if;

  select *
    into v_item
  from public.item_types
  where id = v_source.item_id;

  if not found then
    raise exception 'Inventory item not found' using errcode = 'P0002';
  end if;

  update public.item_stock_locations
  set quantity = coalesce(v_source.quantity, 0) - v_qty,
      last_updated = v_now,
      added_by = auth.uid(),
      confirmation_email = coalesce(v_signed_email, confirmation_email),
      confirmation_method = 'tray_to_storage_transfer',
      confirmed_at = v_now,
      locked_by = null,
      locked_at = null
  where id = v_source.id
  returning * into v_source;

  select *
    into v_dest
  from public.item_stock_locations isl
  where isl.item_id = v_source.item_id
    and isl.location_id = v_dest_container.id
  for update;

  if found then
    update public.item_stock_locations
    set quantity = coalesce(v_dest.quantity, 0) + v_qty,
        last_updated = v_now,
        added_by = auth.uid(),
        confirmation_email = coalesce(v_signed_email, confirmation_email),
        confirmation_method = 'tray_to_storage_transfer',
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
      v_dest_container.id,
      v_qty,
      auth.uid(),
      v_signed_email,
      'tray_to_storage_transfer',
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
      v_source_tray.id,
      -v_qty,
      'transfer',
      v_now,
      auth.uid(),
      v_signed_email,
      'Returned from tray ' || coalesce(v_source_tray.location_name, v_source_tray.location_code) ||
        ' to container ' || coalesce(v_dest_container.location_name, v_dest_container.location_code) ||
        coalesce(' - ' || v_note, ''),
      'tray_to_storage_transfer',
      v_now
    ),
    (
      v_source.item_id,
      v_dest_container.id,
      v_qty,
      'transfer',
      v_now,
      auth.uid(),
      v_signed_email,
      'Received from tray ' || coalesce(v_source_tray.location_name, v_source_tray.location_code) ||
        ' under ' || coalesce(v_parent.location_name, v_parent.location_code) ||
        coalesce(' - ' || v_note, ''),
      'tray_to_storage_transfer',
      v_now
    );

  item_id := v_source.item_id;
  source_stock_row_id := v_source.id;
  destination_stock_row_id := v_dest.id;
  source_location_id := v_source_tray.id;
  destination_location_id := v_dest_container.id;
  transferred_quantity := v_qty;
  source_remaining := v_source.quantity;
  destination_quantity := v_dest.quantity;
  return next;
end;
$$;

revoke all on function public.transfer_tray_stock_to_container(uuid, uuid, uuid, integer, text, text) from public;
grant execute on function public.transfer_tray_stock_to_container(uuid, uuid, uuid, integer, text, text) to authenticated;
