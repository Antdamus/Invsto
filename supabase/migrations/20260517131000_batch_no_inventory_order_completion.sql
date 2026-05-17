-- Batch version of the provisional no-inventory completion path.
-- The UI uses this when a buyer has multiple pending lines that are physically
-- present but not represented in inventory yet.

drop function if exists public.complete_ebay_order_lines_without_inventory(
  uuid[], text, text, uuid, numeric, numeric, numeric, timestamptz, text
);

create or replace function public.complete_ebay_order_lines_without_inventory(
  _order_line_ids uuid[],
  _notes text default null,
  _signed_by_email text default null,
  _checkout_store_id uuid default null,
  _gps_latitude numeric default null,
  _gps_longitude numeric default null,
  _gps_accuracy_meters numeric default null,
  _gps_captured_at timestamptz default null,
  _gps_status text default null,
  _evidence_photos jsonb default '[]'::jsonb
)
returns table (
  updated_lines integer,
  updated_orders integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_line_id uuid;
  v_line public.ebay_order_lines;
  v_order public.ebay_orders;
  v_note text := nullif(btrim(coalesce(_notes, '')), '');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
  v_gps_status text := nullif(btrim(coalesce(_gps_status, '')), '');
  v_now timestamptz := now();
  v_store_name text;
  v_evidence_photos jsonb := case
    when jsonb_typeof(coalesce(_evidence_photos, '[]'::jsonb)) = 'array'
      then coalesce(_evidence_photos, '[]'::jsonb)
    else '[]'::jsonb
  end;
  v_order_ids uuid[] := '{}'::uuid[];
  v_updated_line_ids uuid[] := '{}'::uuid[];
  v_order_id uuid;
  v_order_status text;
  v_updated_lines integer := 0;
  v_updated_orders integer := 0;
  v_snapshots jsonb := '[]'::jsonb;
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to complete eBay orders' using errcode = '42501';
  end if;

  if coalesce(array_length(_order_line_ids, 1), 0) = 0 then
    raise exception 'Select at least one eBay order line' using errcode = '22023';
  end if;

  if _checkout_store_id is not null then
    select name
      into v_store_name
    from public.store_locations
    where id = _checkout_store_id;
  end if;

  v_note := coalesce(
    v_note,
    'Completed without inventory removal: physical item present, not entered in inventory yet.'
  );
  v_gps_status := coalesce(v_gps_status, 'not_requested');

  foreach v_line_id in array _order_line_ids loop
    select *
      into v_line
    from public.ebay_order_lines
    where id = v_line_id
    for update;

    if not found then
      raise exception 'eBay order line not found' using errcode = 'P0002';
    end if;

    if v_line.line_status <> 'pending' or coalesce(v_line.fulfilled_quantity, 0) <> 0 then
      raise exception 'Only untouched pending eBay lines can be completed without inventory removal: %',
        coalesce(v_line.item_title, v_line.id::text)
        using errcode = '22023';
    end if;

    select *
      into v_order
    from public.ebay_orders
    where id = v_line.order_id
    for update;

    if not found then
      raise exception 'eBay order not found' using errcode = 'P0002';
    end if;

    update public.ebay_order_lines
    set line_status = 'fulfilled',
        fulfilled_quantity = quantity,
        fulfilled_by = auth.uid(),
        fulfilled_by_email = v_signed_email,
        fulfilled_at = v_now,
        internal_item_id = null,
        stock_location_row_id = null,
        location_id = null,
        sale_id = null,
        sale_item_id = null,
        stock_transaction_id = null,
        notes = v_note,
        updated_at = v_now
    where id = v_line.id;

    v_updated_lines := v_updated_lines + 1;
    v_updated_line_ids := array_append(v_updated_line_ids, v_line.id);
    if not (v_line.order_id = any(v_order_ids)) then
      v_order_ids := array_append(v_order_ids, v_line.order_id);
    end if;

    v_snapshots := v_snapshots || jsonb_build_array(jsonb_build_object(
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'order_line_id', v_line.id,
      'buyer_username', v_order.buyer_username,
      'item_title', v_line.item_title,
      'item_number', v_line.item_number,
      'custom_label', v_line.custom_label,
      'quantity', v_line.quantity
    ));
  end loop;

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
    set status = v_order_status,
        updated_at = v_now
    where id = v_order_id;

    v_updated_orders := v_updated_orders + 1;
  end loop;

  insert into public.ebay_order_admin_events (
    action,
    order_ids,
    order_line_ids,
    notes,
    signed_by,
    signed_by_email,
    checkout_store_id,
    gps_latitude,
    gps_longitude,
    gps_accuracy_meters,
    gps_captured_at,
    gps_status,
    payload
  )
  values (
    'fulfilled_no_inventory',
    v_order_ids,
    v_updated_line_ids,
    v_note,
    auth.uid(),
    v_signed_email,
    _checkout_store_id,
    _gps_latitude,
    _gps_longitude,
    _gps_accuracy_meters,
    _gps_captured_at,
    v_gps_status,
    jsonb_build_object(
      'source', 'worker_physical_item_not_in_inventory_batch',
      'completed_at', v_now,
      'updated_lines', v_updated_lines,
      'updated_orders', v_updated_orders,
      'checkout_store_id', _checkout_store_id,
      'checkout_store_name', v_store_name,
      'evidence_photos', v_evidence_photos,
      'line_snapshots', v_snapshots,
      'gps', jsonb_build_object(
        'status', v_gps_status,
        'latitude', _gps_latitude,
        'longitude', _gps_longitude,
        'accuracy_meters', _gps_accuracy_meters,
        'captured_at', _gps_captured_at
      )
    )
  );

  updated_lines := v_updated_lines;
  updated_orders := v_updated_orders;
  return next;
end;
$$;

revoke all on function public.complete_ebay_order_lines_without_inventory(
  uuid[], text, text, uuid, numeric, numeric, numeric, timestamptz, text, jsonb
) from public;

grant execute on function public.complete_ebay_order_lines_without_inventory(
  uuid[], text, text, uuid, numeric, numeric, numeric, timestamptz, text, jsonb
) to authenticated;
