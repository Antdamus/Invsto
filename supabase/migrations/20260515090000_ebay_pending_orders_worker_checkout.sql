-- Worker-facing eBay pending order fulfillment.
-- Imports land in ebay_orders / ebay_order_lines; workers fulfill each line by
-- selecting the exact internal item and source stock row they are shipping.

create table if not exists public.ebay_orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  sales_record_number text,
  buyer_username text,
  buyer_name text,
  buyer_email text,
  item_location text,
  item_zip_code text,
  item_country text,
  payment_method text,
  sale_date timestamptz,
  paid_on_date timestamptz,
  ship_by_date timestamptz,
  shipped_on_date timestamptz,
  tracking_number text,
  shipping_service text,
  shipping_and_handling numeric(12,2) default 0,
  seller_collected_tax numeric(12,2) default 0,
  ebay_collected_tax numeric(12,2) default 0,
  ebay_collected_charges numeric(12,2) default 0,
  total_price numeric(12,2) default 0,
  net_payout numeric(12,2),
  status text not null default 'pending'
    check (status in ('pending', 'partially_fulfilled', 'fulfilled', 'cancelled', 'archived')),
  raw_payload jsonb not null default '{}'::jsonb,
  imported_by uuid references auth.users(id) on delete set null,
  imported_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ebay_order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.ebay_orders(id) on delete cascade,
  item_number text,
  transaction_id text,
  item_title text not null,
  custom_label text,
  quantity integer not null default 1 check (quantity > 0),
  sold_for numeric(12,2) default 0,
  shipping_and_handling numeric(12,2) default 0,
  total_price numeric(12,2) default 0,
  net_payout numeric(12,2),
  line_status text not null default 'pending'
    check (line_status in ('pending', 'partially_fulfilled', 'fulfilled', 'cancelled', 'skipped')),
  internal_item_id uuid references public.item_types(id) on delete set null,
  stock_location_row_id uuid references public.item_stock_locations(id) on delete set null,
  location_id uuid references public.locations(id) on delete set null,
  fulfilled_quantity integer not null default 0 check (fulfilled_quantity >= 0),
  fulfilled_by uuid references auth.users(id) on delete set null,
  fulfilled_by_email text,
  fulfilled_at timestamptz,
  sale_id uuid references public.sales(id) on delete set null,
  sale_item_id uuid references public.sale_items(id) on delete set null,
  stock_transaction_id uuid references public.stock_transactions(id) on delete set null,
  notes text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_id, item_number, transaction_id)
);

create index if not exists ebay_orders_status_ship_by_idx
  on public.ebay_orders(status, ship_by_date nulls first, paid_on_date desc);

create index if not exists ebay_order_lines_status_idx
  on public.ebay_order_lines(line_status, created_at desc);

create index if not exists ebay_order_lines_custom_label_idx
  on public.ebay_order_lines(custom_label)
  where custom_label is not null;

alter table public.ebay_orders enable row level security;
alter table public.ebay_order_lines enable row level security;

drop policy if exists "ebay_orders_select_inventory_staff" on public.ebay_orders;
create policy "ebay_orders_select_inventory_staff"
on public.ebay_orders
for select
to authenticated
using (public.can_manage_inventory());

drop policy if exists "ebay_order_lines_select_inventory_staff" on public.ebay_order_lines;
create policy "ebay_order_lines_select_inventory_staff"
on public.ebay_order_lines
for select
to authenticated
using (public.can_manage_inventory());

drop policy if exists "ebay_orders_admin_write" on public.ebay_orders;
create policy "ebay_orders_admin_write"
on public.ebay_orders
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "ebay_order_lines_admin_write" on public.ebay_order_lines;
create policy "ebay_order_lines_admin_write"
on public.ebay_order_lines
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

grant select on table public.ebay_orders to authenticated;
grant select on table public.ebay_order_lines to authenticated;
grant select, insert, update, delete on table public.ebay_orders to service_role;
grant select, insert, update, delete on table public.ebay_order_lines to service_role;

create or replace function public.touch_ebay_order_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_ebay_orders_updated_at on public.ebay_orders;
create trigger trg_ebay_orders_updated_at
before update on public.ebay_orders
for each row execute function public.touch_ebay_order_updated_at();

drop trigger if exists trg_ebay_order_lines_updated_at on public.ebay_order_lines;
create trigger trg_ebay_order_lines_updated_at
before update on public.ebay_order_lines
for each row execute function public.touch_ebay_order_updated_at();

create or replace function public.fulfill_ebay_order_line(
  _order_line_id uuid,
  _item_id uuid,
  _stock_location_row_id uuid,
  _quantity integer,
  _sold_price numeric default null,
  _net_payout numeric default null,
  _notes text default null,
  _signed_by_email text default null
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
  v_line public.ebay_order_lines;
  v_order public.ebay_orders;
  v_stock public.item_stock_locations;
  v_item public.item_types;
  v_sale_id uuid;
  v_sale_item_id uuid;
  v_tx_id uuid;
  v_qty integer := coalesce(_quantity, 0);
  v_unit_price numeric(12,2);
  v_line_total numeric(12,2);
  v_net_payout numeric(12,2);
  v_fee_amount numeric(12,2);
  v_fee_percent numeric(7,4);
  v_remaining integer;
  v_now timestamptz := now();
  v_notes text := nullif(btrim(coalesce(_notes, '')), '');
  v_order_status text;
  v_snapshot jsonb;
  v_new_fulfilled_quantity integer;
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to fulfill eBay orders' using errcode = '42501';
  end if;

  if _order_line_id is null or _item_id is null or _stock_location_row_id is null then
    raise exception 'Order line, item, and source location are required' using errcode = '22023';
  end if;

  if v_qty <= 0 then
    raise exception 'Quantity must be greater than zero' using errcode = '22023';
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
    raise exception 'This eBay order line is already closed' using errcode = '23505';
  end if;

  select *
    into v_order
  from public.ebay_orders
  where id = v_line.order_id
  for update;

  if not found then
    raise exception 'eBay order not found' using errcode = 'P0002';
  end if;

  select *
    into v_item
  from public.item_types
  where id = _item_id;

  if not found then
    raise exception 'Inventory item not found' using errcode = 'P0002';
  end if;

  select *
    into v_stock
  from public.item_stock_locations
  where id = _stock_location_row_id
  for update;

  if not found then
    raise exception 'Source stock row not found' using errcode = 'P0002';
  end if;

  if v_stock.item_id is distinct from _item_id then
    raise exception 'The selected source location does not contain that item' using errcode = '22023';
  end if;

  if (coalesce(v_line.fulfilled_quantity, 0) + v_qty) > v_line.quantity then
    raise exception 'This would fulfill more units than the eBay line requires' using errcode = '22023';
  end if;

  if coalesce(v_stock.quantity, 0) < v_qty then
    raise exception 'Only % units are available at the selected source', coalesce(v_stock.quantity, 0) using errcode = '22023';
  end if;

  v_unit_price := coalesce(_sold_price, v_line.sold_for, v_item.sale_price, 0);
  v_line_total := round(v_unit_price * v_qty, 2);
  v_net_payout := coalesce(
    _net_payout,
    v_line.net_payout,
    case
      when coalesce(v_line.total_price, 0) > 0 and coalesce(v_order.total_price, 0) > 0
        then greatest(round(
          v_line.total_price
          - (coalesce(v_order.ebay_collected_tax, 0) * (v_line.total_price / v_order.total_price))
          - (coalesce(v_order.ebay_collected_charges, 0) * (v_line.total_price / v_order.total_price))
          - (coalesce(v_order.seller_collected_tax, 0) * (v_line.total_price / v_order.total_price)),
          2
        ), 0)
      when coalesce(v_line.total_price, 0) > 0
        then v_line.total_price
      else null
    end,
    case
      when coalesce(v_order.net_payout, 0) > 0 and coalesce(v_order.total_price, 0) > 0
        then round(v_order.net_payout * (v_line_total / v_order.total_price), 2)
      else null
    end,
    v_line_total
  );
  v_fee_amount := greatest(round(v_line_total - v_net_payout, 2), 0);
  v_fee_percent := case when v_line_total > 0 then round((v_fee_amount / v_line_total) * 100, 4) else 0 end;
  v_remaining := coalesce(v_stock.quantity, 0) - v_qty;

  update public.item_stock_locations
  set quantity = v_remaining,
      locked_by = null,
      locked_at = null
  where id = v_stock.id;

  v_snapshot := jsonb_build_array(jsonb_build_object(
    'ebay_order_number', v_order.order_number,
    'ebay_item_number', v_line.item_number,
    'ebay_transaction_id', v_line.transaction_id,
    'ebay_buyer_username', v_order.buyer_username,
    'item_id', v_item.id,
    'title', v_item.title,
    'barcode', v_item.barcode,
    'quantity', v_qty,
    'sale_price', v_unit_price,
    'line_total', v_line_total,
    'net_payout', v_net_payout,
    'source_stock_row_id', v_stock.id,
    'location_id', v_stock.location_id
  ));

  select s.id
    into v_sale_id
  from public.sales s
  where s.platform = 'ebay'
    and s.external_sales_id = v_order.order_number
  order by s.created_at desc
  limit 1;

  if v_sale_id is null then
    insert into public.sales (
      external_sales_id,
      user_id,
      email,
      platform,
      subtotal,
      credits_applied,
      total_discount,
      final_amount,
      platform_fee_amount,
      platform_fee_percent,
      profit_amount,
      flagged,
      verified_method,
      verified_at,
      created_at
    )
    values (
      v_order.order_number,
      auth.uid(),
      nullif(_signed_by_email, ''),
      'ebay',
      coalesce(nullif(v_order.total_price, 0), v_line_total),
      0,
      0,
      coalesce(nullif(v_order.total_price, 0), v_line_total),
      v_fee_amount,
      v_fee_percent,
      v_net_payout,
      false,
      'authenticated_session',
      v_now,
      v_now
    )
    returning id into v_sale_id;
  end if;

  insert into public.sale_items (
    sale_id,
    item_id,
    title,
    quantity,
    sale_price,
    discount_percent,
    discount_amount,
    final_price,
    remaining_stock_qty,
    location_id,
    photo_path
  )
  values (
    v_sale_id,
    v_item.id,
    v_item.title,
    v_qty,
    v_unit_price,
    0,
    0,
    v_line_total,
    v_remaining,
    v_stock.location_id,
    coalesce((v_item.photos)[1], '')
  )
  returning id into v_sale_item_id;

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
  values (
    v_item.id,
    v_stock.location_id,
    -v_qty,
    'checkout',
    v_now,
    auth.uid(),
    nullif(_signed_by_email, ''),
    'eBay pending order ' || v_order.order_number || coalesce(' - ' || v_notes, ''),
    'ebay_pending_order',
    v_now
  )
  returning id into v_tx_id;

  insert into public.sales_audit (
    external_sales_id,
    subtotal,
    credits_applied,
    owes_after_credit,
    per_item_discount,
    general_discount,
    effective_discount_pct,
    owes_store,
    platform_fee_amount,
    platform_fee_percent,
    profit_amount,
    platform,
    cart_snapshot,
    flagged,
    notes,
    verified_method,
    verified_at,
    created_at,
    email,
    user_id,
    credits_breakdown
  )
  values (
    v_order.order_number,
    v_line_total,
    0,
    v_line_total,
    0,
    0,
    0,
    v_line_total,
    v_fee_amount,
    v_fee_percent,
    v_net_payout,
    'ebay',
    v_snapshot,
    false,
    coalesce(v_notes, 'Worker fulfilled pending eBay order'),
    'authenticated_session',
    v_now,
    v_now,
    nullif(_signed_by_email, ''),
    auth.uid(),
    '[]'::jsonb
  );

  insert into public.sale_item_categories (sale_item_id, category)
  select v_sale_item_id, category
  from unnest(coalesce(v_item.categories, '{}'::text[])) as category;

  v_new_fulfilled_quantity := coalesce(v_line.fulfilled_quantity, 0) + v_qty;

  update public.ebay_order_lines
  set line_status = case when v_new_fulfilled_quantity >= quantity then 'fulfilled' else 'partially_fulfilled' end,
      internal_item_id = v_item.id,
      stock_location_row_id = v_stock.id,
      location_id = v_stock.location_id,
      fulfilled_quantity = v_new_fulfilled_quantity,
      fulfilled_by = auth.uid(),
      fulfilled_by_email = nullif(_signed_by_email, ''),
      fulfilled_at = v_now,
      sale_id = v_sale_id,
      sale_item_id = v_sale_item_id,
      stock_transaction_id = v_tx_id,
      notes = v_notes
  where id = v_line.id;

  v_order_status := case
    when not exists (
      select 1
      from public.ebay_order_lines l
      where l.order_id = v_order.id
        and l.line_status not in ('fulfilled', 'cancelled', 'skipped')
    ) then 'fulfilled'
    when exists (
      select 1
      from public.ebay_order_lines l
      where l.order_id = v_order.id
        and l.line_status in ('fulfilled', 'partially_fulfilled')
    ) then 'partially_fulfilled'
    else 'pending'
  end;

  update public.ebay_orders
  set status = v_order_status
  where id = v_order.id;

  order_id := v_order.id;
  order_line_id := v_line.id;
  sale_id := v_sale_id;
  sale_item_id := v_sale_item_id;
  stock_transaction_id := v_tx_id;
  item_id := v_item.id;
  remaining_stock := v_remaining;
  return next;
end;
$$;

revoke all on function public.fulfill_ebay_order_line(
  uuid, uuid, uuid, integer, numeric, numeric, text, text
) from public;

grant execute on function public.fulfill_ebay_order_line(
  uuid, uuid, uuid, integer, numeric, numeric, text, text
) to authenticated;
