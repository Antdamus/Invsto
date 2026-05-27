-- Seller commission automation.
-- Posts 5% commission from seller-attributed sale items, then creates
-- deduction rows when attributed eBay lines are cancelled or returned.

create unique index if not exists seller_commission_ledger_source_unique
  on public.seller_commission_ledger(seller_employee_id, source_type, source_id)
  where source_id is not null;

create index if not exists seller_commission_ledger_source_lookup_idx
  on public.seller_commission_ledger(source_type, source_id)
  where source_id is not null;

create index if not exists seller_commission_ledger_order_line_idx
  on public.seller_commission_ledger(ebay_order_line_id, source_type)
  where ebay_order_line_id is not null;

create or replace function public.seller_employee_snapshot(_employee_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (
      select jsonb_build_object(
        'id', e.id,
        'display_name', e.display_name,
        'email', e.email,
        'role', e.role
      )
      from public.employees e
      where e.id = _employee_id
    ),
    '{}'::jsonb
  );
$$;

create or replace function public.seller_commission_parse_money(_value text)
returns numeric
language sql
immutable
as $$
  select case
    when regexp_replace(coalesce(_value, ''), '[^0-9.\-]', '', 'g') ~ '^-?[0-9]+(\.[0-9]+)?$'
      then regexp_replace(coalesce(_value, ''), '[^0-9.\-]', '', 'g')::numeric
    else null::numeric
  end;
$$;

create or replace function public.find_seller_sale_shift_for_commission(
  _seller_employee_id uuid,
  _channel text,
  _sold_at timestamptz default null,
  _store_id uuid default null
)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_shift_id uuid;
  v_channel text := lower(nullif(btrim(coalesce(_channel, '')), ''));
  v_sold_at timestamptz := coalesce(_sold_at, now());
begin
  if _seller_employee_id is null or v_channel not in ('ebay', 'whatnot') then
    return null;
  end if;

  select s.id
    into v_shift_id
  from public.seller_sale_shifts s
  where s.seller_employee_id = _seller_employee_id
    and s.channel = v_channel
    and s.status = any (public.seller_sale_active_statuses())
    and (_store_id is null or s.store_id is null or s.store_id = _store_id)
    and s.start_at::date <= v_sold_at::date
    and s.end_at::date >= v_sold_at::date
  order by
    case when v_sold_at between s.start_at and s.end_at then 0 else 1 end,
    abs(extract(epoch from (s.start_at - v_sold_at))),
    s.start_at
  limit 1;

  return v_shift_id;
end;
$$;

create or replace function public.sync_seller_commission_for_sale_item(_sale_item_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.sale_items;
  v_sale public.sales;
  v_line public.ebay_order_lines;
  v_order public.ebay_orders;
  v_seller_id uuid;
  v_shift_id uuid;
  v_snapshot jsonb := '{}'::jsonb;
  v_channel text;
  v_sold_at timestamptz;
  v_store_id uuid;
  v_line_alloc_total numeric(12,2);
  v_ratio numeric := 1;
  v_gross numeric(12,2);
  v_shipping numeric(12,2) := 0;
  v_tax numeric(12,2) := 0;
  v_platform_fee numeric(12,2) := 0;
  v_net numeric(12,2);
  v_label text;
  v_ledger_id uuid;
begin
  select *
    into v_item
  from public.sale_items
  where id = _sale_item_id;

  if not found then
    return null;
  end if;

  select *
    into v_sale
  from public.sales
  where id = v_item.sale_id;

  if not found then
    return null;
  end if;

  select l.*
    into v_line
  from public.ebay_order_lines l
  where l.sale_item_id = v_item.id
  order by l.fulfilled_at desc nulls last, l.updated_at desc
  limit 1;

  if not found then
    select l.*
      into v_line
    from public.live_sale_lot_items li
    join public.ebay_order_lines l on l.id = li.packed_order_line_id
    where li.packed_sale_item_id = v_item.id
    order by li.packed_at desc nulls last, li.created_at desc
    limit 1;
  end if;

  if found then
    select *
      into v_order
    from public.ebay_orders
    where id = v_line.order_id;
  end if;

  v_channel := lower(coalesce(nullif(btrim(v_sale.platform), ''), 'ebay'));
  if v_channel not in ('ebay', 'whatnot') then
    return null;
  end if;

  v_seller_id := coalesce(v_item.seller_employee_id, v_line.assigned_seller_employee_id, v_sale.seller_employee_id);
  if v_seller_id is null then
    return null;
  end if;

  v_snapshot := public.seller_employee_snapshot(v_seller_id);
  v_sold_at := coalesce(v_order.sale_date, v_order.paid_on_date, v_sale.created_at, v_item.created_at, now());

  select l.store_id
    into v_store_id
  from public.locations l
  where l.id = v_item.location_id;

  v_shift_id := coalesce(
    v_item.seller_sale_shift_id,
    v_sale.seller_sale_shift_id,
    public.find_seller_sale_shift_for_commission(v_seller_id, v_channel, v_sold_at, v_store_id)
  );

  if v_item.seller_employee_id is distinct from v_seller_id
     or v_item.seller_sale_shift_id is distinct from v_shift_id
     or coalesce(v_item.seller_snapshot, '{}'::jsonb) is distinct from coalesce(v_snapshot, '{}'::jsonb) then
    update public.sale_items
    set seller_employee_id = v_seller_id,
        seller_sale_shift_id = v_shift_id,
        seller_snapshot = coalesce(v_snapshot, '{}'::jsonb)
    where id = v_item.id;
  end if;

  if not exists (
    select 1
    from public.sale_items sibling
    where sibling.sale_id = v_item.sale_id
      and sibling.seller_employee_id is not null
      and sibling.seller_employee_id <> v_seller_id
  ) then
    update public.sales
    set seller_employee_id = v_seller_id,
        seller_sale_shift_id = v_shift_id,
        seller_snapshot = coalesce(v_snapshot, '{}'::jsonb)
    where id = v_sale.id
      and (
        seller_employee_id is distinct from v_seller_id
        or seller_sale_shift_id is distinct from v_shift_id
        or coalesce(seller_snapshot, '{}'::jsonb) is distinct from coalesce(v_snapshot, '{}'::jsonb)
      );
  end if;

  v_gross := round(coalesce(v_item.final_price, 0), 2);

  if v_line.id is not null then
    select coalesce(sum(coalesce(si.final_price, 0)), 0)
      into v_line_alloc_total
    from public.live_sale_lot_items li
    join public.sale_items si on si.id = li.packed_sale_item_id
    where li.packed_order_line_id = v_line.id;

    v_line_alloc_total := coalesce(
      nullif(v_line_alloc_total, 0),
      nullif(v_line.total_price, 0),
      nullif(v_line.sold_for, 0),
      nullif(v_gross, 0),
      1
    );
    v_ratio := least(greatest(v_gross / v_line_alloc_total, 0), 1);
    v_shipping := round(coalesce(v_line.shipping_and_handling, 0) * v_ratio, 2);
    v_tax := round(
      (
        coalesce(v_order.seller_collected_tax, 0)
        + coalesce(v_order.ebay_collected_tax, 0)
        + coalesce(v_order.ebay_collected_charges, 0)
      ) * v_ratio,
      2
    );
    v_net := round(greatest(coalesce(v_line.net_payout, v_gross) * v_ratio - v_shipping, 0), 2);
  else
    v_ratio := case
      when coalesce(v_sale.final_amount, 0) > 0 then least(greatest(v_gross / v_sale.final_amount, 0), 1)
      else 1
    end;
    v_platform_fee := round(coalesce(v_sale.platform_fee_amount, 0) * v_ratio, 2);
    v_net := round(greatest(coalesce(v_sale.profit_amount, v_gross - v_platform_fee, v_gross) * v_ratio, 0), 2);
  end if;

  if v_platform_fee = 0 then
    v_platform_fee := round(greatest(v_gross - v_net, 0), 2);
  end if;

  v_label := concat_ws(
    ' - ',
    case when v_channel = 'whatnot' then 'Whatnot sale' else 'eBay sale' end,
    nullif(coalesce(v_order.order_number, v_sale.external_sales_id), ''),
    nullif(v_item.title, '')
  );

  update public.seller_commission_ledger
  set status = 'void',
      net_store_proceeds = 0,
      commission_amount = 0,
      notes = concat_ws(E'\n', nullif(notes, ''), 'Voided because this sale item was assigned to a different seller.'),
      updated_at = now()
  where source_type = 'sale'
    and source_id = v_item.id::text
    and seller_employee_id <> v_seller_id
    and status not in ('paid', 'void');

  insert into public.seller_commission_ledger (
    seller_employee_id,
    shift_id,
    channel,
    sale_id,
    sale_item_id,
    ebay_order_line_id,
    source_type,
    source_id,
    source_label,
    gross_amount,
    shipping_amount,
    tax_amount,
    platform_fee_amount,
    net_store_proceeds,
    status,
    metadata
  )
  values (
    v_seller_id,
    v_shift_id,
    v_channel,
    v_sale.id,
    v_item.id,
    v_line.id,
    'sale',
    v_item.id::text,
    v_label,
    v_gross,
    coalesce(v_shipping, 0),
    coalesce(v_tax, 0),
    coalesce(v_platform_fee, 0),
    coalesce(v_net, 0),
    'earned',
    jsonb_build_object(
      'source', 'seller_commission_sale_item_sync',
      'sale_item_id', v_item.id,
      'sale_id', v_sale.id,
      'ebay_order_line_id', v_line.id,
      'ebay_order_number', v_order.order_number,
      'allocation_ratio', v_ratio,
      'commission_basis', 'net_store_proceeds_after_shipping_tax_platform_fees_returns'
    )
  )
  on conflict (seller_employee_id, source_type, source_id) where source_id is not null
  do update
    set shift_id = excluded.shift_id,
        channel = excluded.channel,
        sale_id = excluded.sale_id,
        sale_item_id = excluded.sale_item_id,
        ebay_order_line_id = excluded.ebay_order_line_id,
        source_label = excluded.source_label,
        gross_amount = excluded.gross_amount,
        shipping_amount = excluded.shipping_amount,
        tax_amount = excluded.tax_amount,
        platform_fee_amount = excluded.platform_fee_amount,
        net_store_proceeds = excluded.net_store_proceeds,
        status = case
          when public.seller_commission_ledger.status in ('paid', 'void') then public.seller_commission_ledger.status
          else excluded.status
        end,
        metadata = coalesce(public.seller_commission_ledger.metadata, '{}'::jsonb) || excluded.metadata,
        updated_at = now()
    where public.seller_commission_ledger.status not in ('paid', 'void')
  returning id into v_ledger_id;

  return v_ledger_id;
end;
$$;

create or replace function public.trg_sync_seller_commission_for_sale_item()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.sync_seller_commission_for_sale_item(new.id);
  return new;
end;
$$;

drop trigger if exists trg_sync_seller_commission_for_sale_item on public.sale_items;
create trigger trg_sync_seller_commission_for_sale_item
after insert or update of sale_id, final_price, quantity, location_id, seller_employee_id, seller_sale_shift_id
on public.sale_items
for each row execute function public.trg_sync_seller_commission_for_sale_item();

create or replace function public.sync_seller_from_ebay_order_line(_order_line_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_line public.ebay_order_lines;
  v_order public.ebay_orders;
  v_shift_id uuid;
  v_snapshot jsonb := '{}'::jsonb;
  v_sold_at timestamptz;
  v_sale_item_id uuid;
begin
  select *
    into v_line
  from public.ebay_order_lines
  where id = _order_line_id;

  if not found or v_line.assigned_seller_employee_id is null then
    return;
  end if;

  select *
    into v_order
  from public.ebay_orders
  where id = v_line.order_id;

  v_sold_at := coalesce(v_order.sale_date, v_order.paid_on_date, v_line.fulfilled_at, now());
  v_shift_id := public.find_seller_sale_shift_for_commission(v_line.assigned_seller_employee_id, 'ebay', v_sold_at, null);
  v_snapshot := public.seller_employee_snapshot(v_line.assigned_seller_employee_id);

  for v_sale_item_id in
    select v_line.sale_item_id
    where v_line.sale_item_id is not null
    union
    select li.packed_sale_item_id
    from public.live_sale_lot_items li
    where li.packed_order_line_id = v_line.id
      and li.packed_sale_item_id is not null
  loop
    update public.sale_items
    set seller_employee_id = v_line.assigned_seller_employee_id,
        seller_sale_shift_id = coalesce(seller_sale_shift_id, v_shift_id),
        seller_snapshot = coalesce(v_snapshot, '{}'::jsonb)
    where id = v_sale_item_id
      and (
        seller_employee_id is distinct from v_line.assigned_seller_employee_id
        or seller_sale_shift_id is null
        or coalesce(seller_snapshot, '{}'::jsonb) is distinct from coalesce(v_snapshot, '{}'::jsonb)
      );

    perform public.sync_seller_commission_for_sale_item(v_sale_item_id);
  end loop;
end;
$$;

create or replace function public.sync_seller_from_live_sale_lot_item(_lot_item_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lot_item public.live_sale_lot_items;
  v_lot public.live_sale_lots;
  v_line public.ebay_order_lines;
  v_order public.ebay_orders;
  v_shift_id uuid;
  v_snapshot jsonb := '{}'::jsonb;
  v_sold_at timestamptz;
begin
  select *
    into v_lot_item
  from public.live_sale_lot_items
  where id = _lot_item_id;

  if not found
     or v_lot_item.packed_sale_item_id is null
     or v_lot_item.packed_order_line_id is null then
    return;
  end if;

  select *
    into v_lot
  from public.live_sale_lots
  where id = v_lot_item.lot_id;

  if not found or v_lot.owner_employee_id is null then
    return;
  end if;

  select *
    into v_line
  from public.ebay_order_lines
  where id = v_lot_item.packed_order_line_id;

  if found then
    select *
      into v_order
    from public.ebay_orders
    where id = v_line.order_id;
  end if;

  v_sold_at := coalesce(v_order.sale_date, v_order.paid_on_date, v_lot_item.packed_at, now());
  v_shift_id := public.find_seller_sale_shift_for_commission(v_lot.owner_employee_id, 'ebay', v_sold_at, null);
  v_snapshot := public.seller_employee_snapshot(v_lot.owner_employee_id);

  update public.sale_items
  set seller_employee_id = v_lot.owner_employee_id,
      seller_sale_shift_id = coalesce(seller_sale_shift_id, v_shift_id),
      seller_snapshot = coalesce(v_snapshot, '{}'::jsonb)
  where id = v_lot_item.packed_sale_item_id
    and (
      seller_employee_id is distinct from v_lot.owner_employee_id
      or seller_sale_shift_id is null
      or coalesce(seller_snapshot, '{}'::jsonb) is distinct from coalesce(v_snapshot, '{}'::jsonb)
    );

  perform public.sync_seller_commission_for_sale_item(v_lot_item.packed_sale_item_id);
end;
$$;

create or replace function public.trg_sync_seller_from_live_sale_lot_item()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.sync_seller_from_live_sale_lot_item(new.id);
  return new;
end;
$$;

create or replace function public.assign_seller_to_sale_item(
  _sale_item_id uuid,
  _seller_employee_id uuid,
  _seller_sale_shift_id uuid default null,
  _notes text default null
)
returns public.sale_items
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.sale_items;
  v_snapshot jsonb := '{}'::jsonb;
begin
  if not (public.can_manage_inventory() or public.current_user_can_manage_sellers()) then
    raise exception 'Not allowed to assign sellers to sale items' using errcode = '42501';
  end if;

  if _seller_employee_id is null or not exists (
    select 1
    from public.employees e
    where e.id = _seller_employee_id
      and e.active is distinct from false
      and lower(coalesce(e.role, '')) in ('seller', 'employee', 'manager', 'admin')
  ) then
    raise exception 'Select an active seller' using errcode = '22023';
  end if;

  v_snapshot := public.seller_employee_snapshot(_seller_employee_id);

  update public.sale_items
  set seller_employee_id = _seller_employee_id,
      seller_sale_shift_id = _seller_sale_shift_id,
      seller_snapshot = coalesce(v_snapshot, '{}'::jsonb)
  where id = _sale_item_id
  returning * into v_item;

  if not found then
    raise exception 'Sale item not found' using errcode = 'P0002';
  end if;

  update public.ebay_order_lines
  set assigned_seller_employee_id = _seller_employee_id,
      assigned_seller_snapshot = coalesce(v_snapshot, '{}'::jsonb),
      notes = concat_ws(E'\n', nullif(notes, ''), nullif(btrim(_notes), '')),
      updated_at = now()
  where sale_item_id = v_item.id;

  perform public.sync_seller_commission_for_sale_item(v_item.id);
  return v_item;
end;
$$;

create or replace function public.assign_seller_to_ebay_order_line(
  _order_line_id uuid,
  _seller_employee_id uuid,
  _seller_sale_shift_id uuid default null,
  _notes text default null
)
returns public.ebay_order_lines
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_line public.ebay_order_lines;
  v_snapshot jsonb := '{}'::jsonb;
  v_sale_item_id uuid;
begin
  if not (public.can_manage_inventory() or public.current_user_can_manage_sellers()) then
    raise exception 'Not allowed to assign sellers to eBay order lines' using errcode = '42501';
  end if;

  if _seller_employee_id is null or not exists (
    select 1
    from public.employees e
    where e.id = _seller_employee_id
      and e.active is distinct from false
      and lower(coalesce(e.role, '')) in ('seller', 'employee', 'manager', 'admin')
  ) then
    raise exception 'Select an active seller' using errcode = '22023';
  end if;

  v_snapshot := public.seller_employee_snapshot(_seller_employee_id);

  update public.ebay_order_lines
  set assigned_seller_employee_id = _seller_employee_id,
      assigned_seller_snapshot = coalesce(v_snapshot, '{}'::jsonb),
      notes = concat_ws(E'\n', nullif(notes, ''), nullif(btrim(_notes), '')),
      updated_at = now()
  where id = _order_line_id
  returning * into v_line;

  if not found then
    raise exception 'eBay order line not found' using errcode = 'P0002';
  end if;

  for v_sale_item_id in
    select v_line.sale_item_id
    where v_line.sale_item_id is not null
    union
    select li.packed_sale_item_id
    from public.live_sale_lot_items li
    where li.packed_order_line_id = v_line.id
      and li.packed_sale_item_id is not null
  loop
    update public.sale_items
    set seller_employee_id = _seller_employee_id,
        seller_sale_shift_id = coalesce(_seller_sale_shift_id, seller_sale_shift_id),
        seller_snapshot = coalesce(v_snapshot, '{}'::jsonb)
    where id = v_sale_item_id;

    perform public.sync_seller_commission_for_sale_item(v_sale_item_id);
  end loop;

  return v_line;
end;
$$;

create or replace function public.record_seller_commission_cancellation(
  _order_line_id uuid,
  _reason text default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_line public.ebay_order_lines;
  v_order public.ebay_orders;
  v_row record;
  v_count integer := 0;
begin
  select *
    into v_line
  from public.ebay_order_lines
  where id = _order_line_id;

  if not found then
    return 0;
  end if;

  select *
    into v_order
  from public.ebay_orders
  where id = v_line.order_id;

  if v_line.sale_item_id is not null then
    perform public.sync_seller_commission_for_sale_item(v_line.sale_item_id);
  end if;

  for v_row in
    select
      l.seller_employee_id,
      max(l.shift_id) as shift_id,
      max(l.channel) as channel,
      max(l.sale_id) as sale_id,
      max(l.ebay_order_line_id) as ebay_order_line_id,
      sum(l.gross_amount) as gross_amount,
      sum(l.shipping_amount) as shipping_amount,
      sum(l.tax_amount) as tax_amount,
      sum(l.platform_fee_amount) as platform_fee_amount,
      sum(l.net_store_proceeds) as net_store_proceeds,
      string_agg(distinct coalesce(l.source_label, ''), ', ' order by coalesce(l.source_label, '')) as source_label
    from public.seller_commission_ledger l
    where l.source_type = 'sale'
      and l.ebay_order_line_id = v_line.id
      and l.status <> 'void'
    group by l.seller_employee_id
  loop
    insert into public.seller_commission_ledger (
      seller_employee_id,
      shift_id,
      channel,
      sale_id,
      ebay_order_line_id,
      source_type,
      source_id,
      source_label,
      gross_amount,
      shipping_amount,
      tax_amount,
      platform_fee_amount,
      refund_amount,
      net_store_proceeds,
      status,
      notes,
      metadata
    )
    values (
      v_row.seller_employee_id,
      v_row.shift_id,
      coalesce(v_row.channel, 'ebay'),
      v_row.sale_id,
      v_line.id,
      'cancellation',
      v_line.id::text,
      concat_ws(' - ', 'Cancellation', coalesce(v_order.order_number, v_line.item_title), nullif(v_line.item_title, '')),
      -abs(coalesce(v_row.gross_amount, 0)),
      -abs(coalesce(v_row.shipping_amount, 0)),
      -abs(coalesce(v_row.tax_amount, 0)),
      -abs(coalesce(v_row.platform_fee_amount, 0)),
      abs(coalesce(v_row.net_store_proceeds, 0)),
      -abs(coalesce(v_row.net_store_proceeds, 0)),
      'deducted',
      nullif(btrim(coalesce(_reason, '')), ''),
      jsonb_build_object(
        'source', 'seller_commission_cancellation',
        'order_line_id', v_line.id,
        'order_number', v_order.order_number,
        'item_title', v_line.item_title
      )
    )
    on conflict (seller_employee_id, source_type, source_id) where source_id is not null
    do update
      set shift_id = excluded.shift_id,
          channel = excluded.channel,
          sale_id = excluded.sale_id,
          ebay_order_line_id = excluded.ebay_order_line_id,
          source_label = excluded.source_label,
          gross_amount = excluded.gross_amount,
          shipping_amount = excluded.shipping_amount,
          tax_amount = excluded.tax_amount,
          platform_fee_amount = excluded.platform_fee_amount,
          refund_amount = excluded.refund_amount,
          net_store_proceeds = excluded.net_store_proceeds,
          status = case
            when public.seller_commission_ledger.status = 'paid' then public.seller_commission_ledger.status
            else 'deducted'
          end,
          metadata = coalesce(public.seller_commission_ledger.metadata, '{}'::jsonb) || excluded.metadata,
          updated_at = now()
      where public.seller_commission_ledger.status <> 'paid';

    perform public.create_seller_notification(
      v_row.seller_employee_id,
      'seller',
      'commission_cancellation_deduction',
      'Cancelled sale deducted from commission',
      'A cancelled eBay sale was deducted from your commission ledger: '
        || coalesce(v_order.order_number, v_line.item_title, v_line.id::text)
        || '. Deduction basis: '
        || to_char(abs(coalesce(v_row.net_store_proceeds, 0)), 'FM$999,999,990.00')
        || ' net store proceeds.',
      'normal',
      v_row.shift_id,
      null,
      jsonb_build_object(
        'order_line_id', v_line.id,
        'order_number', v_order.order_number,
        'net_store_proceeds_deducted', abs(coalesce(v_row.net_store_proceeds, 0))
      )
    );

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

create or replace function public.trg_sync_seller_from_ebay_order_line()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.sync_seller_from_ebay_order_line(new.id);

  if new.line_status = 'cancelled'
     and (tg_op = 'INSERT' or old.line_status is distinct from new.line_status) then
    perform public.record_seller_commission_cancellation(new.id, 'eBay order line cancelled');
  end if;

  return new;
end;
$$;

create or replace function public.record_seller_commission_return_item(_return_item_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_return_item public.ebay_return_items;
  v_case public.ebay_return_cases;
  v_line public.ebay_order_lines;
  v_order public.ebay_orders;
  v_ratio numeric := 1;
  v_proof_url text;
  v_row record;
  v_count integer := 0;
begin
  select *
    into v_return_item
  from public.ebay_return_items
  where id = _return_item_id;

  if not found then
    return 0;
  end if;

  select *
    into v_case
  from public.ebay_return_cases
  where id = v_return_item.return_case_id;

  if found and v_case.status = 'cancelled' then
    return 0;
  end if;

  update public.seller_commission_ledger
  set status = 'void',
      net_store_proceeds = 0,
      commission_amount = 0,
      notes = concat_ws(E'\n', nullif(notes, ''), 'Voided because item-level return evidence superseded this case-level deduction.'),
      updated_at = now()
  where source_type = 'return'
    and source_id like ('case:' || v_return_item.return_case_id::text || ':%')
    and status not in ('paid', 'void');

  select *
    into v_line
  from public.ebay_order_lines
  where id = v_return_item.order_line_id;

  if not found then
    return 0;
  end if;

  select *
    into v_order
  from public.ebay_orders
  where id = v_line.order_id;

  if v_line.sale_item_id is not null then
    perform public.sync_seller_commission_for_sale_item(v_line.sale_item_id);
  end if;

  v_ratio := case
    when coalesce(v_return_item.expected_quantity, 0) > 0
      then least(greatest(coalesce(v_return_item.received_quantity, 0)::numeric / v_return_item.expected_quantity::numeric, 0), 1)
    else 1
  end;

  if v_ratio = 0 and v_return_item.disposition = 'refund_only' then
    v_ratio := 1;
  end if;

  select coalesce(
      e.evidence_photos->0->>'url',
      e.evidence_photos->0->>'signedUrl',
      e.evidence_photos->0->>'path',
      e.evidence_photos->0->>'storagePath'
    )
    into v_proof_url
  from public.ebay_return_events e
  where e.return_case_id = v_return_item.return_case_id
    and (
      e.return_item_ids @> array[v_return_item.id]
      or jsonb_array_length(coalesce(e.evidence_photos, '[]'::jsonb)) > 0
    )
  order by case when e.return_item_ids @> array[v_return_item.id] then 0 else 1 end, e.created_at desc
  limit 1;

  for v_row in
    select *
    from public.seller_commission_ledger l
    where l.source_type = 'sale'
      and l.ebay_order_line_id = v_line.id
      and l.status <> 'void'
  loop
    insert into public.seller_commission_ledger (
      seller_employee_id,
      shift_id,
      channel,
      sale_id,
      sale_item_id,
      ebay_order_line_id,
      source_type,
      source_id,
      source_label,
      gross_amount,
      shipping_amount,
      tax_amount,
      platform_fee_amount,
      refund_amount,
      net_store_proceeds,
      status,
      return_case_id,
      return_proof_url,
      notes,
      metadata
    )
    values (
      v_row.seller_employee_id,
      v_row.shift_id,
      v_row.channel,
      v_row.sale_id,
      v_row.sale_item_id,
      v_line.id,
      'return',
      v_return_item.id::text || ':' || v_row.id::text,
      concat_ws(' - ', 'Return', coalesce(v_order.order_number, v_case.order_number), nullif(v_return_item.item_title, '')),
      -round(abs(coalesce(v_row.gross_amount, 0)) * v_ratio, 2),
      -round(abs(coalesce(v_row.shipping_amount, 0)) * v_ratio, 2),
      -round(abs(coalesce(v_row.tax_amount, 0)) * v_ratio, 2),
      -round(abs(coalesce(v_row.platform_fee_amount, 0)) * v_ratio, 2),
      round(abs(coalesce(v_row.net_store_proceeds, 0)) * v_ratio, 2),
      -round(abs(coalesce(v_row.net_store_proceeds, 0)) * v_ratio, 2),
      'deducted',
      v_return_item.return_case_id,
      v_proof_url,
      concat_ws(E'\n', nullif(v_return_item.notes, ''), nullif(v_case.notes, '')),
      jsonb_build_object(
        'source', 'seller_commission_return_item',
        'return_item_id', v_return_item.id,
        'return_case_id', v_return_item.return_case_id,
        'order_line_id', v_line.id,
        'order_number', coalesce(v_order.order_number, v_case.order_number),
        'received_quantity', v_return_item.received_quantity,
        'expected_quantity', v_return_item.expected_quantity,
        'deduction_ratio', v_ratio,
        'condition_received', v_return_item.condition_received,
        'disposition', v_return_item.disposition,
        'return_proof_url', v_proof_url
      )
    )
    on conflict (seller_employee_id, source_type, source_id) where source_id is not null
    do update
      set shift_id = excluded.shift_id,
          channel = excluded.channel,
          sale_id = excluded.sale_id,
          sale_item_id = excluded.sale_item_id,
          ebay_order_line_id = excluded.ebay_order_line_id,
          source_label = excluded.source_label,
          gross_amount = excluded.gross_amount,
          shipping_amount = excluded.shipping_amount,
          tax_amount = excluded.tax_amount,
          platform_fee_amount = excluded.platform_fee_amount,
          refund_amount = excluded.refund_amount,
          net_store_proceeds = excluded.net_store_proceeds,
          status = case
            when public.seller_commission_ledger.status = 'paid' then public.seller_commission_ledger.status
            else 'deducted'
          end,
          return_case_id = excluded.return_case_id,
          return_proof_url = excluded.return_proof_url,
          notes = excluded.notes,
          metadata = coalesce(public.seller_commission_ledger.metadata, '{}'::jsonb) || excluded.metadata,
          updated_at = now()
      where public.seller_commission_ledger.status <> 'paid';

    perform public.create_seller_notification(
      v_row.seller_employee_id,
      'seller',
      'commission_return_deduction',
      'Return deducted from commission',
      'An eBay return was deducted from your commission ledger: '
        || coalesce(v_order.order_number, v_case.order_number, v_return_item.item_title, v_return_item.id::text)
        || '. Deduction basis: '
        || to_char(round(abs(coalesce(v_row.net_store_proceeds, 0)) * v_ratio, 2), 'FM$999,999,990.00')
        || ' net store proceeds.',
      'normal',
      v_row.shift_id,
      null,
      jsonb_build_object(
        'return_item_id', v_return_item.id,
        'return_case_id', v_return_item.return_case_id,
        'order_line_id', v_line.id,
        'order_number', coalesce(v_order.order_number, v_case.order_number),
        'return_proof_url', v_proof_url,
        'net_store_proceeds_deducted', round(abs(coalesce(v_row.net_store_proceeds, 0)) * v_ratio, 2)
      )
    );

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

create or replace function public.record_seller_commission_return_case(_return_case_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_case public.ebay_return_cases;
  v_order public.ebay_orders;
  v_refund_amount numeric(12,2);
  v_total_basis numeric(12,2);
  v_proof_url text;
  v_row record;
  v_deduction numeric(12,2);
  v_count integer := 0;
begin
  select *
    into v_case
  from public.ebay_return_cases
  where id = _return_case_id;

  if not found or v_case.status in ('open', 'cancelled') then
    return 0;
  end if;

  if exists (
    select 1
    from public.ebay_return_items ri
    where ri.return_case_id = v_case.id
  ) then
    return 0;
  end if;

  select *
    into v_order
  from public.ebay_orders
  where id = v_case.order_id
     or (v_case.order_id is null and v_case.order_number is not null and order_number = v_case.order_number)
  order by imported_at desc
  limit 1;

  if not found then
    return 0;
  end if;

  v_refund_amount := coalesce(
    public.seller_commission_parse_money(v_case.raw_payload->>'requestAmount'),
    public.seller_commission_parse_money(v_case.raw_payload->'returnDetails'->>'requestAmount'),
    public.seller_commission_parse_money(v_case.raw_payload->'summary'->>'requestAmount'),
    public.seller_commission_parse_money(v_case.raw_payload->>'refundText'),
    public.seller_commission_parse_money(v_case.raw_payload->>'sellerTotalRefund')
  );

  if coalesce(v_refund_amount, 0) <= 0 then
    return 0;
  end if;

  for v_row in
    select si.id
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
    where s.platform = 'ebay'
      and s.external_sales_id = v_order.order_number
  loop
    perform public.sync_seller_commission_for_sale_item(v_row.id);
  end loop;

  select coalesce(sum(abs(l.net_store_proceeds)), 0)
    into v_total_basis
  from public.seller_commission_ledger l
  where l.source_type = 'sale'
    and l.status <> 'void'
    and exists (
      select 1
      from public.ebay_order_lines line
      where line.id = l.ebay_order_line_id
        and line.order_id = v_order.id
    );

  if coalesce(v_total_basis, 0) <= 0 then
    return 0;
  end if;

  select coalesce(
      e.evidence_photos->0->>'url',
      e.evidence_photos->0->>'signedUrl',
      e.evidence_photos->0->>'path',
      e.evidence_photos->0->>'storagePath'
    )
    into v_proof_url
  from public.ebay_return_events e
  where e.return_case_id = v_case.id
    and jsonb_array_length(coalesce(e.evidence_photos, '[]'::jsonb)) > 0
  order by e.created_at desc
  limit 1;

  for v_row in
    select l.*
    from public.seller_commission_ledger l
    join public.ebay_order_lines line on line.id = l.ebay_order_line_id
    where l.source_type = 'sale'
      and l.status <> 'void'
      and line.order_id = v_order.id
  loop
    v_deduction := round(least(abs(v_row.net_store_proceeds), v_refund_amount * (abs(v_row.net_store_proceeds) / v_total_basis)), 2);

    if v_deduction <= 0 then
      continue;
    end if;

    insert into public.seller_commission_ledger (
      seller_employee_id,
      shift_id,
      channel,
      sale_id,
      sale_item_id,
      ebay_order_line_id,
      source_type,
      source_id,
      source_label,
      refund_amount,
      net_store_proceeds,
      status,
      return_case_id,
      return_proof_url,
      notes,
      metadata
    )
    values (
      v_row.seller_employee_id,
      v_row.shift_id,
      v_row.channel,
      v_row.sale_id,
      v_row.sale_item_id,
      v_row.ebay_order_line_id,
      'return',
      'case:' || v_case.id::text || ':' || v_row.id::text,
      concat_ws(' - ', 'Return', coalesce(v_order.order_number, v_case.order_number), nullif(v_case.return_reason, '')),
      v_deduction,
      -v_deduction,
      'deducted',
      v_case.id,
      v_proof_url,
      v_case.notes,
      jsonb_build_object(
        'source', 'seller_commission_return_case',
        'return_case_id', v_case.id,
        'order_number', coalesce(v_order.order_number, v_case.order_number),
        'refund_amount', v_refund_amount,
        'return_proof_url', v_proof_url
      )
    )
    on conflict (seller_employee_id, source_type, source_id) where source_id is not null
    do update
      set source_label = excluded.source_label,
          refund_amount = excluded.refund_amount,
          net_store_proceeds = excluded.net_store_proceeds,
          status = case
            when public.seller_commission_ledger.status = 'paid' then public.seller_commission_ledger.status
            else 'deducted'
          end,
          return_case_id = excluded.return_case_id,
          return_proof_url = excluded.return_proof_url,
          notes = excluded.notes,
          metadata = coalesce(public.seller_commission_ledger.metadata, '{}'::jsonb) || excluded.metadata,
          updated_at = now()
      where public.seller_commission_ledger.status <> 'paid';

    perform public.create_seller_notification(
      v_row.seller_employee_id,
      'seller',
      'commission_return_deduction',
      'Return deducted from commission',
      'An eBay return was deducted from your commission ledger: '
        || coalesce(v_order.order_number, v_case.order_number, v_case.ebay_return_id, v_case.id::text)
        || '. Deduction basis: '
        || to_char(v_deduction, 'FM$999,999,990.00')
        || ' net store proceeds.',
      'normal',
      v_row.shift_id,
      null,
      jsonb_build_object(
        'return_case_id', v_case.id,
        'order_number', coalesce(v_order.order_number, v_case.order_number),
        'return_proof_url', v_proof_url,
        'net_store_proceeds_deducted', v_deduction
      )
    );

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

create or replace function public.trg_record_seller_commission_return_item()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.record_seller_commission_return_item(new.id);
  return new;
end;
$$;

create or replace function public.trg_record_seller_commission_return_case()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.record_seller_commission_return_case(new.id);
  return new;
end;
$$;

drop trigger if exists trg_sync_seller_from_ebay_order_line on public.ebay_order_lines;
create trigger trg_sync_seller_from_ebay_order_line
after insert or update of assigned_seller_employee_id, sale_item_id, line_status, fulfilled_at
on public.ebay_order_lines
for each row execute function public.trg_sync_seller_from_ebay_order_line();

drop trigger if exists trg_sync_seller_from_live_sale_lot_item on public.live_sale_lot_items;
create trigger trg_sync_seller_from_live_sale_lot_item
after insert or update of packed_sale_item_id, packed_order_line_id, status
on public.live_sale_lot_items
for each row execute function public.trg_sync_seller_from_live_sale_lot_item();

drop trigger if exists trg_record_seller_commission_return_item on public.ebay_return_items;
create trigger trg_record_seller_commission_return_item
after insert or update of received_quantity, expected_quantity, disposition, notes
on public.ebay_return_items
for each row execute function public.trg_record_seller_commission_return_item();

drop trigger if exists trg_record_seller_commission_return_case on public.ebay_return_cases;
create trigger trg_record_seller_commission_return_case
after insert or update of status, raw_payload, closed_at
on public.ebay_return_cases
for each row execute function public.trg_record_seller_commission_return_case();

create or replace function public.next_seller_commission_friday(_from date default current_date)
returns date
language sql
stable
as $$
  select (_from + (((5 - extract(dow from _from)::integer + 7) % 7))::integer)::date;
$$;

create or replace function public.create_seller_commission_payouts(
  _period_start date default null,
  _period_end date default null,
  _payout_date date default null
)
returns table (
  payout_id uuid,
  seller_employee_id uuid,
  gross_commission numeric,
  deductions numeric,
  net_commission numeric,
  included_entries integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_period_end date := coalesce(_period_end, current_date);
  v_period_start date := coalesce(_period_start, coalesce(_period_end, current_date) - 6);
  v_payout_date date := coalesce(_payout_date, public.next_seller_commission_friday(coalesce(_period_end, current_date)));
  v_row record;
  v_payout_id uuid;
begin
  if not public.current_user_can_manage_sellers() then
    raise exception 'Only management can prepare seller commission payouts' using errcode = '42501';
  end if;

  if v_period_end < v_period_start then
    raise exception 'Payout period end must be on or after period start' using errcode = '22023';
  end if;

  for v_row in
    select
      l.seller_employee_id,
      round(sum(greatest(l.commission_amount, 0)), 2) as gross_commission,
      round(abs(sum(least(l.commission_amount, 0))), 2) as deductions,
      round(sum(l.commission_amount), 2) as net_commission,
      count(*)::integer as included_entries
    from public.seller_commission_ledger l
    where l.payout_id is null
      and l.status in ('earned', 'deducted', 'payable')
      and l.created_at::date between v_period_start and v_period_end
      and coalesce(l.commission_amount, 0) <> 0
    group by l.seller_employee_id
    having round(sum(l.commission_amount), 2) <> 0
  loop
    insert into public.seller_commission_payouts (
      seller_employee_id,
      period_start,
      period_end,
      payout_date,
      gross_commission,
      deductions,
      net_commission,
      status,
      approved_by,
      approved_at,
      metadata
    )
    values (
      v_row.seller_employee_id,
      v_period_start,
      v_period_end,
      v_payout_date,
      v_row.gross_commission,
      v_row.deductions,
      v_row.net_commission,
      'draft',
      auth.uid(),
      now(),
      jsonb_build_object(
        'source', 'create_seller_commission_payouts',
        'included_entries', v_row.included_entries
      )
    )
    returning id into v_payout_id;

    update public.seller_commission_ledger l
    set payout_id = v_payout_id,
        status = 'payable',
        updated_at = now()
    where l.payout_id is null
      and l.seller_employee_id = v_row.seller_employee_id
      and l.status in ('earned', 'deducted', 'payable')
      and l.created_at::date between v_period_start and v_period_end
      and coalesce(l.commission_amount, 0) <> 0;

    payout_id := v_payout_id;
    seller_employee_id := v_row.seller_employee_id;
    gross_commission := v_row.gross_commission;
    deductions := v_row.deductions;
    net_commission := v_row.net_commission;
    included_entries := v_row.included_entries;
    return next;
  end loop;
end;
$$;

create or replace function public.mark_seller_commission_payout_paid(
  _payout_id uuid,
  _notes text default null
)
returns public.seller_commission_payouts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payout public.seller_commission_payouts;
begin
  if not public.current_user_can_manage_sellers() then
    raise exception 'Only management can mark seller commission payouts paid' using errcode = '42501';
  end if;

  update public.seller_commission_payouts
  set status = 'paid',
      paid_by = auth.uid(),
      paid_at = now(),
      notes = concat_ws(E'\n', nullif(notes, ''), nullif(btrim(_notes), '')),
      updated_at = now()
  where id = _payout_id
    and status in ('draft', 'approved')
  returning * into v_payout;

  if not found then
    raise exception 'Open seller commission payout not found' using errcode = 'P0002';
  end if;

  update public.seller_commission_ledger
  set status = 'paid',
      updated_at = now()
  where payout_id = v_payout.id
    and status = 'payable';

  perform public.create_seller_notification(
    v_payout.seller_employee_id,
    'seller',
    'commission_payout_paid',
    'Commission payout paid',
    'Your commission payout for '
      || v_payout.period_start::text
      || ' to '
      || v_payout.period_end::text
      || ' was marked paid: '
      || to_char(v_payout.net_commission, 'FM$999,999,990.00')
      || '.',
    'normal',
    null,
    null,
    jsonb_build_object(
      'payout_id', v_payout.id,
      'period_start', v_payout.period_start,
      'period_end', v_payout.period_end,
      'net_commission', v_payout.net_commission
    )
  );

  return v_payout;
end;
$$;

revoke all on function public.seller_employee_snapshot(uuid) from public;
revoke all on function public.seller_commission_parse_money(text) from public;
revoke all on function public.find_seller_sale_shift_for_commission(uuid, text, timestamptz, uuid) from public;
revoke all on function public.sync_seller_commission_for_sale_item(uuid) from public;
revoke all on function public.sync_seller_from_ebay_order_line(uuid) from public;
revoke all on function public.sync_seller_from_live_sale_lot_item(uuid) from public;
revoke all on function public.assign_seller_to_sale_item(uuid, uuid, uuid, text) from public;
revoke all on function public.assign_seller_to_ebay_order_line(uuid, uuid, uuid, text) from public;
revoke all on function public.record_seller_commission_cancellation(uuid, text) from public;
revoke all on function public.record_seller_commission_return_item(uuid) from public;
revoke all on function public.record_seller_commission_return_case(uuid) from public;
revoke all on function public.next_seller_commission_friday(date) from public;
revoke all on function public.create_seller_commission_payouts(date, date, date) from public;
revoke all on function public.mark_seller_commission_payout_paid(uuid, text) from public;

grant execute on function public.assign_seller_to_sale_item(uuid, uuid, uuid, text) to authenticated;
grant execute on function public.assign_seller_to_ebay_order_line(uuid, uuid, uuid, text) to authenticated;
grant execute on function public.next_seller_commission_friday(date) to authenticated;
grant execute on function public.create_seller_commission_payouts(date, date, date) to authenticated;
grant execute on function public.mark_seller_commission_payout_paid(uuid, text) to authenticated;
