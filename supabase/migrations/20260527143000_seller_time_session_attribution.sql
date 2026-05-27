-- Time/session seller attribution.
-- Unambiguous sale times can attach a seller automatically; overlapping sellers
-- still require the live-show bag owner or packing user to choose the seller.

create or replace function public.infer_seller_shift_for_sale_time(
  _channel text,
  _sold_at timestamptz,
  _store_id uuid default null,
  _session_id uuid default null
)
returns table (
  seller_employee_id uuid,
  shift_id uuid,
  candidate_count integer,
  source text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_channel text := lower(nullif(btrim(coalesce(_channel, '')), ''));
  v_sold_at timestamptz := coalesce(_sold_at, now());
  v_count integer := 0;
begin
  seller_employee_id := null;
  shift_id := null;
  candidate_count := 0;
  source := 'none';

  if v_channel not in ('ebay', 'whatnot') then
    return next;
    return;
  end if;

  if _session_id is not null then
    with session_sellers as (
      select s.primary_seller_employee_id as employee_id
      from public.live_sale_sessions s
      where s.id = _session_id
        and s.primary_seller_employee_id is not null
      union
      select unnest(coalesce(s.co_seller_employee_ids, '{}'::uuid[])) as employee_id
      from public.live_sale_sessions s
      where s.id = _session_id
    ),
    active_session_sellers as (
      select distinct e.id as employee_id
      from session_sellers ss
      join public.employees e on e.id = ss.employee_id
      where e.active is distinct from false
    )
    select count(*), min(employee_id)
      into v_count, seller_employee_id
    from active_session_sellers;

    if v_count = 1 then
      shift_id := public.find_seller_sale_shift_for_commission(seller_employee_id, v_channel, v_sold_at, _store_id);
      candidate_count := 1;
      source := 'live_sale_session';
      return next;
      return;
    elsif v_count > 1 then
      seller_employee_id := null;
      shift_id := null;
      candidate_count := v_count;
      source := 'live_sale_session_ambiguous';
      return next;
      return;
    end if;
  end if;

  with candidates as (
    select
      s.seller_employee_id,
      s.id as shift_id
    from public.seller_sale_shifts s
    join public.employees e on e.id = s.seller_employee_id
    where s.channel = v_channel
      and s.status = any (public.seller_sale_active_statuses())
      and e.active is distinct from false
      and (_store_id is null or s.store_id is null or s.store_id = _store_id)
      and v_sold_at >= s.start_at
      and v_sold_at < s.end_at
  )
  select count(*), min(c.seller_employee_id), min(c.shift_id)
    into v_count, seller_employee_id, shift_id
  from candidates c;

  candidate_count := coalesce(v_count, 0);
  if candidate_count = 1 then
    source := 'seller_shift_time';
  elsif candidate_count > 1 then
    seller_employee_id := null;
    shift_id := null;
    source := 'seller_shift_time_ambiguous';
  else
    source := 'none';
  end if;

  return next;
end;
$$;

create or replace function public.auto_assign_seller_by_sale_time(
  _sale_item_id uuid,
  _order_line_id uuid default null,
  _session_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.sale_items;
  v_sale public.sales;
  v_line public.ebay_order_lines;
  v_order public.ebay_orders;
  v_session public.live_sale_sessions;
  v_store_id uuid;
  v_channel text;
  v_sold_at timestamptz;
  v_inference record;
  v_snapshot jsonb := '{}'::jsonb;
begin
  if _sale_item_id is null then
    return jsonb_build_object('status', 'skipped', 'reason', 'missing_sale_item');
  end if;

  select *
    into v_item
  from public.sale_items
  where id = _sale_item_id;

  if not found then
    return jsonb_build_object('status', 'skipped', 'reason', 'sale_item_not_found');
  end if;

  if v_item.seller_employee_id is not null then
    return jsonb_build_object('status', 'skipped', 'reason', 'sale_item_already_assigned', 'seller_employee_id', v_item.seller_employee_id);
  end if;

  select *
    into v_sale
  from public.sales
  where id = v_item.sale_id;

  if _order_line_id is not null then
    select *
      into v_line
    from public.ebay_order_lines
    where id = _order_line_id;
  else
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
  end if;

  if v_line.id is not null and v_line.assigned_seller_employee_id is not null then
    return jsonb_build_object('status', 'skipped', 'reason', 'order_line_already_assigned', 'seller_employee_id', v_line.assigned_seller_employee_id);
  end if;

  if v_line.id is not null then
    select *
      into v_order
    from public.ebay_orders
    where id = v_line.order_id;
  end if;

  if _session_id is not null then
    select *
      into v_session
    from public.live_sale_sessions
    where id = _session_id;
  else
    select s.*
      into v_session
    from public.live_sale_lot_items li
    join public.live_sale_sessions s on s.id = li.session_id
    where li.packed_sale_item_id = v_item.id
       or (v_line.id is not null and li.packed_order_line_id = v_line.id)
    order by li.packed_at desc nulls last, li.scanned_at desc nulls last
    limit 1;
  end if;

  v_channel := lower(coalesce(nullif(btrim(v_sale.platform), ''), 'ebay'));
  if v_channel not in ('ebay', 'whatnot') then
    return jsonb_build_object('status', 'skipped', 'reason', 'unsupported_channel', 'channel', v_channel);
  end if;

  select l.store_id
    into v_store_id
  from public.locations l
  where l.id = v_item.location_id;

  v_store_id := coalesce(v_store_id, v_session.store_id);
  v_sold_at := coalesce(v_order.sale_date, v_order.paid_on_date, v_session.started_at, v_sale.created_at, v_item.created_at, now());

  select *
    into v_inference
  from public.infer_seller_shift_for_sale_time(v_channel, v_sold_at, v_store_id, v_session.id)
  limit 1;

  if coalesce(v_inference.candidate_count, 0) <> 1 or v_inference.seller_employee_id is null then
    return jsonb_build_object(
      'status', 'unassigned',
      'reason', coalesce(v_inference.source, 'none'),
      'candidate_count', coalesce(v_inference.candidate_count, 0),
      'channel', v_channel,
      'sold_at', v_sold_at
    );
  end if;

  v_snapshot := public.seller_employee_snapshot(v_inference.seller_employee_id);

  update public.sale_items
  set seller_employee_id = v_inference.seller_employee_id,
      seller_sale_shift_id = v_inference.shift_id,
      seller_snapshot = coalesce(v_snapshot, '{}'::jsonb)
  where id = v_item.id
    and seller_employee_id is null;

  if v_line.id is not null then
    update public.ebay_order_lines
    set assigned_seller_employee_id = v_inference.seller_employee_id,
        assigned_seller_snapshot = coalesce(v_snapshot, '{}'::jsonb),
        updated_at = now()
    where id = v_line.id
      and assigned_seller_employee_id is null;
  end if;

  perform public.sync_seller_commission_for_sale_item(v_item.id);

  return jsonb_build_object(
    'status', 'assigned',
    'source', v_inference.source,
    'seller_employee_id', v_inference.seller_employee_id,
    'shift_id', v_inference.shift_id,
    'channel', v_channel,
    'sold_at', v_sold_at
  );
end;
$$;

create or replace function public.trg_auto_assign_seller_by_sale_item_time()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.seller_employee_id is null then
    perform public.auto_assign_seller_by_sale_time(new.id, null, null);
  end if;
  return new;
end;
$$;

create or replace function public.trg_auto_assign_seller_by_order_line_time()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sale_item_id uuid;
begin
  if new.assigned_seller_employee_id is not null then
    return new;
  end if;

  for v_sale_item_id in
    select new.sale_item_id
    where new.sale_item_id is not null
    union
    select li.packed_sale_item_id
    from public.live_sale_lot_items li
    where li.packed_order_line_id = new.id
      and li.packed_sale_item_id is not null
  loop
    perform public.auto_assign_seller_by_sale_time(v_sale_item_id, new.id, null);
  end loop;

  return new;
end;
$$;

drop trigger if exists trg_auto_assign_seller_by_sale_item_time on public.sale_items;
create trigger trg_auto_assign_seller_by_sale_item_time
after insert or update of sale_id, created_at, location_id, seller_employee_id
on public.sale_items
for each row execute function public.trg_auto_assign_seller_by_sale_item_time();

drop trigger if exists trg_auto_assign_seller_by_order_line_time on public.ebay_order_lines;
create trigger trg_auto_assign_seller_by_order_line_time
after insert or update of sale_item_id, line_status, fulfilled_at, assigned_seller_employee_id
on public.ebay_order_lines
for each row execute function public.trg_auto_assign_seller_by_order_line_time();

revoke all on function public.infer_seller_shift_for_sale_time(text, timestamptz, uuid, uuid) from public;
revoke all on function public.auto_assign_seller_by_sale_time(uuid, uuid, uuid) from public;

grant execute on function public.infer_seller_shift_for_sale_time(text, timestamptz, uuid, uuid) to authenticated;
grant execute on function public.auto_assign_seller_by_sale_time(uuid, uuid, uuid) to authenticated;
