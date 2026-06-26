-- Keep the pending-order queue RPC as a first-paint fast path.
-- Receipt and note evidence are hydrated through the existing detail/background
-- task paths; joining task events in this RPC can make the whole queue stall.

drop function if exists public.list_pending_ebay_order_queue(text, boolean, integer, integer);

create or replace function public.list_pending_ebay_order_queue(
  _status text default 'pending',
  _include_admin_fields boolean default false,
  _limit integer default 1000,
  _offset integer default 0
)
returns table (
  id uuid,
  order_id uuid,
  item_number text,
  transaction_id text,
  item_title text,
  custom_label text,
  quantity integer,
  sold_for numeric,
  shipping_and_handling numeric,
  total_price numeric,
  net_payout numeric,
  line_status text,
  created_at timestamptz,
  internal_item_id uuid,
  fulfilled_quantity integer,
  fulfilled_at timestamptz,
  assigned_seller_employee_id uuid,
  assigned_seller_snapshot jsonb,
  notes text,
  order_record_id uuid,
  order_number text,
  sales_record_number text,
  buyer_username text,
  buyer_name text,
  sale_date timestamptz,
  paid_on_date timestamptz,
  imported_at timestamptz,
  ship_by_date timestamptz,
  payment_method text,
  order_shipping_and_handling numeric,
  ebay_collected_tax numeric,
  order_total_price numeric,
  order_net_payout numeric,
  order_status text,
  label_status text,
  label_storage_bucket text,
  label_file_path text,
  label_uploaded_at timestamptz,
  video_receipt_photo_count integer,
  line_note_count integer,
  latest_line_note text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text := lower(coalesce(nullif(btrim(_status), ''), 'pending'));
  v_limit integer := least(greatest(coalesce(_limit, 1000), 1), 2000);
  v_offset integer := greatest(coalesce(_offset, 0), 0);
  v_include_admin_fields boolean := public.is_admin() and coalesce(_include_admin_fields, false);
  v_line_statuses text[];
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  v_line_statuses := case
    when v_status = 'pending' then array['pending', 'partially_fulfilled']::text[]
    when v_status = 'fulfilled' then array['fulfilled']::text[]
    else array['pending', 'partially_fulfilled', 'fulfilled']::text[]
  end;

  return query
  select
    l.id,
    l.order_id,
    l.item_number,
    l.transaction_id,
    l.item_title,
    l.custom_label,
    l.quantity,
    l.sold_for,
    l.shipping_and_handling,
    l.total_price,
    case when v_include_admin_fields then l.net_payout else null::numeric end as net_payout,
    l.line_status,
    l.created_at,
    l.internal_item_id,
    l.fulfilled_quantity,
    l.fulfilled_at,
    l.assigned_seller_employee_id,
    coalesce(l.assigned_seller_snapshot, '{}'::jsonb) as assigned_seller_snapshot,
    l.notes,
    o.id as order_record_id,
    o.order_number,
    o.sales_record_number,
    o.buyer_username,
    o.buyer_name,
    o.sale_date,
    o.paid_on_date,
    o.imported_at,
    o.ship_by_date,
    case when v_include_admin_fields then o.payment_method else null::text end as payment_method,
    case when v_include_admin_fields then o.shipping_and_handling else null::numeric end as order_shipping_and_handling,
    case when v_include_admin_fields then o.ebay_collected_tax else null::numeric end as ebay_collected_tax,
    o.total_price as order_total_price,
    case when v_include_admin_fields then o.net_payout else null::numeric end as order_net_payout,
    o.status as order_status,
    o.label_status,
    o.label_storage_bucket,
    o.label_file_path,
    o.label_uploaded_at,
    0::integer as video_receipt_photo_count,
    0::integer as line_note_count,
    ''::text as latest_line_note
  from public.ebay_order_lines l
  join public.ebay_orders o on o.id = l.order_id
  where l.line_status = any(v_line_statuses)
  order by l.created_at desc, l.id desc
  limit v_limit
  offset v_offset;
end;
$$;

revoke all on function public.list_pending_ebay_order_queue(text, boolean, integer, integer) from public;
grant execute on function public.list_pending_ebay_order_queue(text, boolean, integer, integer) to authenticated;

comment on function public.list_pending_ebay_order_queue(text, boolean, integer, integer)
  is 'Fast pending eBay order queue read path. Keeps receipt/note count columns in the response shape without joining task events during first paint.';

notify pgrst, 'reload schema';
