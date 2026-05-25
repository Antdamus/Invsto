-- Allow the eBay order-line trigger to reserve stock internally.
-- Direct RPC calls still require service role or an inventory-capable user.

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
  if pg_trigger_depth() = 0 and v_role <> 'service_role' and not public.can_manage_inventory() then
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
