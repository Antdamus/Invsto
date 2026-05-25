-- Step 4E.10 manual live sync enablement flag.
-- This only records mailbox eligibility for future operator-invoked sync work.

alter table public.microsoft_mailbox_connections
add column if not exists live_sync_enabled boolean not null default false;

do $$
declare
  existing_constraint record;
begin
  for existing_constraint in
    select conname
    from pg_constraint
    where conrelid = 'public.email_operational_events'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%event_type%'
  loop
    execute format('alter table public.email_operational_events drop constraint %I', existing_constraint.conname);
  end loop;

  alter table public.email_operational_events
    add constraint email_operational_events_event_type_check
    check (event_type in (
      'processing_requeue',
      'processing_replay',
      'sync_replay',
      'classification_replay',
      'sync_import_approved',
      'classify_imported',
      'set_live_sync'
    ));
end $$;
-- Buyer profitability summary for synced eBay order history.
-- Uses locally synced orders, lines, and return cases so dashboard reads stay fast.

create or replace function public.list_ebay_buyer_profitability(
  _limit integer default 12,
  _days_back integer default null
)
returns table (
  buyer_username text,
  buyer_name text,
  order_count bigint,
  line_count bigint,
  unit_count bigint,
  gross_sales numeric,
  net_payout numeric,
  avg_order_value numeric,
  pending_order_count bigint,
  pending_line_count bigint,
  cancelled_order_count bigint,
  cancelled_line_count bigint,
  return_count bigint,
  open_return_count bigint,
  return_rate numeric,
  first_purchase_at timestamptz,
  last_purchase_at timestamptz,
  last_order_number text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to view eBay buyer profitability' using errcode = '42501';
  end if;

  return query
  with scoped_orders as (
    select
      eo.id,
      lower(btrim(eo.buyer_username)) as buyer_key,
      nullif(btrim(eo.buyer_username), '') as buyer_username,
      nullif(btrim(eo.buyer_name), '') as buyer_name,
      eo.order_number,
      eo.status,
      coalesce(eo.sale_date, eo.paid_on_date, eo.imported_at) as purchase_at,
      coalesce(eo.total_price, 0)::numeric as total_price,
      coalesce(eo.net_payout, eo.total_price, 0)::numeric as net_payout
    from public.ebay_orders eo
    where nullif(btrim(eo.buyer_username), '') is not null
      and (
        _days_back is null
        or coalesce(eo.sale_date, eo.paid_on_date, eo.imported_at) >= now() - make_interval(days => greatest(_days_back, 0))
      )
  ),
  order_stats as (
    select
      so.buyer_key,
      max(so.buyer_username) as buyer_username,
      max(so.buyer_name) filter (where so.buyer_name is not null) as buyer_name,
      count(*) filter (where so.status not in ('cancelled', 'archived')) as order_count,
      count(*) filter (where so.status in ('pending', 'partially_fulfilled')) as pending_order_count,
      count(*) filter (where so.status = 'cancelled') as cancelled_order_count,
      coalesce(sum(so.total_price) filter (where so.status not in ('cancelled', 'archived')), 0)::numeric as gross_sales,
      coalesce(sum(so.net_payout) filter (where so.status not in ('cancelled', 'archived')), 0)::numeric as net_payout,
      min(so.purchase_at) filter (where so.status not in ('cancelled', 'archived')) as first_purchase_at,
      max(so.purchase_at) filter (where so.status not in ('cancelled', 'archived')) as last_purchase_at
    from scoped_orders so
    group by so.buyer_key
  ),
  line_stats as (
    select
      so.buyer_key,
      count(eol.id) filter (where eol.line_status not in ('cancelled', 'skipped')) as line_count,
      coalesce(sum(eol.quantity) filter (where eol.line_status not in ('cancelled', 'skipped')), 0)::bigint as unit_count,
      count(eol.id) filter (where eol.line_status in ('pending', 'partially_fulfilled')) as pending_line_count,
      count(eol.id) filter (where eol.line_status = 'cancelled') as cancelled_line_count
    from scoped_orders so
    left join public.ebay_order_lines eol on eol.order_id = so.id
    group by so.buyer_key
  ),
  return_stats as (
    select
      lower(btrim(erc.buyer_username)) as buyer_key,
      count(*) filter (where erc.status <> 'cancelled') as return_count,
      count(*) filter (where erc.status not in ('closed', 'cancelled')) as open_return_count
    from public.ebay_return_cases erc
    where nullif(btrim(erc.buyer_username), '') is not null
      and (
        _days_back is null
        or coalesce(erc.opened_at, erc.updated_at) >= now() - make_interval(days => greatest(_days_back, 0))
      )
    group by lower(btrim(erc.buyer_username))
  ),
  last_orders as (
    select
      so.buyer_key,
      so.order_number,
      row_number() over (
        partition by so.buyer_key
        order by so.purchase_at desc nulls last, so.order_number desc
      ) as rn
    from scoped_orders so
    where so.status not in ('cancelled', 'archived')
  )
  select
    os.buyer_username,
    os.buyer_name,
    os.order_count,
    coalesce(ls.line_count, 0) as line_count,
    coalesce(ls.unit_count, 0) as unit_count,
    round(os.gross_sales, 2) as gross_sales,
    round(os.net_payout, 2) as net_payout,
    round(os.gross_sales / nullif(os.order_count, 0), 2) as avg_order_value,
    os.pending_order_count,
    coalesce(ls.pending_line_count, 0) as pending_line_count,
    os.cancelled_order_count,
    coalesce(ls.cancelled_line_count, 0) as cancelled_line_count,
    coalesce(rs.return_count, 0) as return_count,
    coalesce(rs.open_return_count, 0) as open_return_count,
    round(coalesce(rs.return_count, 0)::numeric / nullif(os.order_count, 0), 4) as return_rate,
    os.first_purchase_at,
    os.last_purchase_at,
    lo.order_number as last_order_number
  from order_stats os
  left join line_stats ls on ls.buyer_key = os.buyer_key
  left join return_stats rs on rs.buyer_key = os.buyer_key
  left join last_orders lo on lo.buyer_key = os.buyer_key and lo.rn = 1
  where os.order_count > 0
  order by os.net_payout desc nulls last, os.gross_sales desc nulls last, os.order_count desc
  limit greatest(1, least(coalesce(_limit, 12), 100));
end;
$$;

revoke all on function public.list_ebay_buyer_profitability(integer, integer) from public;
grant execute on function public.list_ebay_buyer_profitability(integer, integer) to authenticated;
