-- Allow inventory staff to complete a pending eBay order line when the
-- physical item is present but the item has not been entered into inventory yet.
-- This does not remove stock. It creates an auditable no-inventory closeout
-- event with user, time, checkout store, GPS status, and order-line details.

alter table public.ebay_order_admin_events
  add column if not exists checkout_store_id uuid references public.store_locations(id) on delete set null,
  add column if not exists gps_latitude numeric,
  add column if not exists gps_longitude numeric,
  add column if not exists gps_accuracy_meters numeric,
  add column if not exists gps_captured_at timestamptz,
  add column if not exists gps_status text;

create or replace function public.complete_ebay_order_line_without_inventory(
  _order_line_id uuid,
  _notes text default null,
  _signed_by_email text default null,
  _checkout_store_id uuid default null,
  _gps_latitude numeric default null,
  _gps_longitude numeric default null,
  _gps_accuracy_meters numeric default null,
  _gps_captured_at timestamptz default null,
  _gps_status text default null
)
returns table (
  order_id uuid,
  order_line_id uuid,
  updated_orders integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_line public.ebay_order_lines;
  v_order public.ebay_orders;
  v_note text := nullif(btrim(coalesce(_notes, '')), '');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
  v_gps_status text := nullif(btrim(coalesce(_gps_status, '')), '');
  v_now timestamptz := now();
  v_order_status text;
  v_store_name text;
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to complete eBay orders' using errcode = '42501';
  end if;

  if _order_line_id is null then
    raise exception 'Select an eBay order line' using errcode = '22023';
  end if;

  select *
    into v_line
  from public.ebay_order_lines
  where id = _order_line_id
  for update;

  if not found then
    raise exception 'eBay order line not found' using errcode = 'P0002';
  end if;

  if v_line.line_status <> 'pending' or coalesce(v_line.fulfilled_quantity, 0) <> 0 then
    raise exception 'Only untouched pending eBay lines can be completed without inventory removal' using errcode = '22023';
  end if;

  select *
    into v_order
  from public.ebay_orders
  where id = v_line.order_id
  for update;

  if not found then
    raise exception 'eBay order not found' using errcode = 'P0002';
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

  v_order_status := case
    when not exists (
      select 1
      from public.ebay_order_lines l
      where l.order_id = v_order.id
        and l.line_status not in ('fulfilled', 'cancelled', 'skipped')
    ) then
      case
        when exists (
          select 1
          from public.ebay_order_lines l
          where l.order_id = v_order.id
            and l.line_status = 'fulfilled'
        ) then 'fulfilled'
        else 'cancelled'
      end
    when exists (
      select 1
      from public.ebay_order_lines l
      where l.order_id = v_order.id
        and l.line_status in ('fulfilled', 'partially_fulfilled')
    ) then 'partially_fulfilled'
    else 'pending'
  end;

  update public.ebay_orders
  set status = v_order_status,
      updated_at = v_now
  where id = v_order.id;

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
    array[v_order.id],
    array[v_line.id],
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
      'source', 'worker_physical_item_not_in_inventory',
      'completed_at', v_now,
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'order_line_id', v_line.id,
      'buyer_username', v_order.buyer_username,
      'item_title', v_line.item_title,
      'item_number', v_line.item_number,
      'custom_label', v_line.custom_label,
      'quantity', v_line.quantity,
      'checkout_store_id', _checkout_store_id,
      'checkout_store_name', v_store_name,
      'gps', jsonb_build_object(
        'status', v_gps_status,
        'latitude', _gps_latitude,
        'longitude', _gps_longitude,
        'accuracy_meters', _gps_accuracy_meters,
        'captured_at', _gps_captured_at
      )
    )
  );

  order_id := v_order.id;
  order_line_id := v_line.id;
  updated_orders := 1;
  return next;
end;
$$;

revoke all on function public.complete_ebay_order_line_without_inventory(
  uuid, text, text, uuid, numeric, numeric, numeric, timestamptz, text
) from public;

grant execute on function public.complete_ebay_order_line_without_inventory(
  uuid, text, text, uuid, numeric, numeric, numeric, timestamptz, text
) to authenticated;
