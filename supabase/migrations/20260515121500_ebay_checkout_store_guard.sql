-- Store-scoped pending eBay checkout wrapper.
-- The browser sends the selected checkout store, and this routine rejects any
-- source row that is not a checked-in tray in that exact store before calling
-- the existing fulfillment routine.

create or replace function public.fulfill_ebay_order_line_for_store(
  _order_line_id uuid,
  _item_id uuid,
  _stock_location_row_id uuid,
  _quantity integer,
  _sold_price numeric default null,
  _net_payout numeric default null,
  _notes text default null,
  _signed_by_email text default null,
  _checkout_store_id uuid default null
)
returns table (
  order_id uuid,
  order_line_id uuid,
  sale_id uuid,
  sale_item_id uuid,
  stock_transaction_id uuid,
  item_id uuid,
  remaining_stock integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_location public.locations;
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to fulfill eBay orders' using errcode = '42501';
  end if;

  if _checkout_store_id is null then
    raise exception 'Checkout store is required' using errcode = '22023';
  end if;

  select l.*
    into v_location
  from public.item_stock_locations isl
  join public.locations l on l.id = isl.location_id
  where isl.id = _stock_location_row_id;

  if not found then
    raise exception 'Source stock row not found' using errcode = 'P0002';
  end if;

  if coalesce(v_location.is_tray, false) is distinct from true
     and coalesce(v_location.location_role, '') <> 'tray' then
    raise exception 'Pending eBay checkout must come from a tray' using errcode = '22023';
  end if;

  if coalesce(v_location.tray_status, 'checked_in') = 'checked_out' then
    raise exception 'That tray is currently checked out and cannot be used for this store checkout' using errcode = '22023';
  end if;

  if coalesce(v_location.tray_current_store_id, v_location.store_id) is distinct from _checkout_store_id then
    raise exception 'That tray is not checked into the selected checkout store' using errcode = '22023';
  end if;

  return query
  select *
  from public.fulfill_ebay_order_line(
    _order_line_id,
    _item_id,
    _stock_location_row_id,
    _quantity,
    _sold_price,
    _net_payout,
    _notes,
    _signed_by_email
  );
end;
$$;
revoke all on function public.fulfill_ebay_order_line_for_store(
  uuid, uuid, uuid, integer, numeric, numeric, text, text, uuid
) from public;
grant execute on function public.fulfill_ebay_order_line_for_store(
  uuid, uuid, uuid, integer, numeric, numeric, text, text, uuid
) to authenticated;
