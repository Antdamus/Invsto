-- Compatibility RPC for deployed clients that still call the original
-- no-inventory completion function with evidence photo support.

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
language sql
security definer
set search_path = public, pg_temp
as $$
  select *
  from public.complete_ebay_order_lines_without_inventory_evidence(
    _order_line_ids,
    _notes,
    _signed_by_email,
    _checkout_store_id,
    _gps_latitude,
    _gps_longitude,
    _gps_accuracy_meters,
    _gps_captured_at,
    _gps_status,
    _evidence_photos
  );
$$;

revoke all on function public.complete_ebay_order_lines_without_inventory(
  uuid[], text, text, uuid, numeric, numeric, numeric, timestamptz, text, jsonb
) from public;

grant execute on function public.complete_ebay_order_lines_without_inventory(
  uuid[], text, text, uuid, numeric, numeric, numeric, timestamptz, text, jsonb
) to authenticated;
