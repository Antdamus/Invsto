-- On-demand buyer insight summary for pending orders, history, and returns.
-- This intentionally reads synced eBay data instead of scanning eBay live on
-- every page load.

create or replace function public.get_ebay_buyer_insights(
  _buyer_username text,
  _days_back integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_buyer_key text := lower(btrim(coalesce(_buyer_username, '')));
  v_result jsonb;
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to view eBay buyer insights' using errcode = '42501';
  end if;

  if v_buyer_key = '' then
    raise exception 'Buyer username is required' using errcode = '22023';
  end if;

  with buyer_orders as (
    select
      eo.id,
      nullif(btrim(eo.buyer_username), '') as buyer_username,
      nullif(btrim(eo.buyer_name), '') as buyer_name,
      eo.order_number,
      eo.status,
      coalesce(eo.sale_date, eo.paid_on_date, eo.imported_at) as purchase_at,
      eo.ship_by_date,
      coalesce(eo.shipping_and_handling, 0)::numeric as shipping_and_handling,
      coalesce(eo.seller_collected_tax, 0)::numeric as seller_collected_tax,
      coalesce(eo.ebay_collected_tax, 0)::numeric as ebay_collected_tax,
      coalesce(eo.total_price, 0)::numeric as total_price,
      coalesce(eo.net_payout, eo.total_price, 0)::numeric as net_payout
    from public.ebay_orders eo
    where lower(btrim(coalesce(eo.buyer_username, ''))) = v_buyer_key
      and (
        _days_back is null
        or coalesce(eo.sale_date, eo.paid_on_date, eo.imported_at) >= now() - make_interval(days => greatest(_days_back, 0))
      )
  ),
  line_base as (
    select
      eol.id,
      eol.order_id,
      eol.item_number,
      eol.item_title,
      eol.custom_label,
      eol.line_status,
      coalesce(eol.quantity, 0)::integer as quantity,
      coalesce(eol.sold_for, 0)::numeric as sold_for,
      coalesce(eol.shipping_and_handling, 0)::numeric as shipping_and_handling,
      coalesce(eol.total_price, 0)::numeric as total_price,
      coalesce(eol.net_payout, eol.total_price, 0)::numeric as net_payout,
      coalesce(
        nullif(array_to_string(it.categories, ', '), ''),
        case
          when eol.item_title ilike '%watch%' then 'Watches'
          when eol.item_title ilike '%bracelet%' or eol.item_title ilike '%bangle%' then 'Bracelets'
          when eol.item_title ilike '%pendant%' or eol.item_title ilike '%necklace%' or eol.item_title ilike '%chain%' then 'Pendants / Necklaces'
          when eol.item_title ilike '%ring%' then 'Rings'
          when eol.item_title ilike '%earring%' then 'Earrings'
          else 'Other'
        end
      ) as category_label,
      bo.purchase_at
    from buyer_orders bo
    join public.ebay_order_lines eol on eol.order_id = bo.id
    left join public.item_types it on it.id = eol.internal_item_id
  ),
  return_base as (
    select
      erc.id,
      erc.ebay_return_id,
      erc.order_number,
      erc.buyer_username,
      erc.return_reason,
      erc.status,
      erc.opened_at,
      erc.closed_at,
      coalesce(
        nullif(btrim(erc.raw_payload->>'requestAmount'), ''),
        nullif(btrim(erc.raw_payload->'returnDetails'->>'requestAmount'), ''),
        nullif(btrim(erc.raw_payload->'summary'->>'requestAmount'), '')
      ) as request_amount,
      coalesce(
        nullif(btrim(erc.raw_payload->>'buyerComment'), ''),
        nullif(btrim(erc.raw_payload->'returnDetails'->>'buyerComment'), ''),
        nullif(btrim(erc.raw_payload->'comments'->>'buyer'), '')
      ) as buyer_comment
    from public.ebay_return_cases erc
    where lower(btrim(coalesce(erc.buyer_username, ''))) = v_buyer_key
      and (
        _days_back is null
        or coalesce(erc.opened_at, erc.updated_at) >= now() - make_interval(days => greatest(_days_back, 0))
      )
  ),
  order_summary as (
    select
      coalesce(max(bo.buyer_username), nullif(btrim(_buyer_username), '')) as buyer_username,
      max(bo.buyer_name) filter (where bo.buyer_name is not null) as buyer_name,
      count(*) filter (where bo.status not in ('cancelled', 'archived')) as order_count,
      count(*) filter (where bo.status in ('pending', 'partially_fulfilled')) as pending_order_count,
      count(*) filter (where bo.status = 'fulfilled') as fulfilled_order_count,
      count(*) filter (where bo.status = 'cancelled') as cancelled_order_count,
      round(coalesce(sum(bo.total_price) filter (where bo.status not in ('cancelled', 'archived')), 0), 2) as gross_sales,
      round(coalesce(sum(bo.net_payout) filter (where bo.status not in ('cancelled', 'archived')), 0), 2) as net_payout,
      round(coalesce(sum(bo.shipping_and_handling) filter (where bo.status not in ('cancelled', 'archived')), 0), 2) as shipping_total,
      min(bo.purchase_at) filter (where bo.status not in ('cancelled', 'archived')) as first_purchase_at,
      max(bo.purchase_at) filter (where bo.status not in ('cancelled', 'archived')) as last_purchase_at
    from buyer_orders bo
  ),
  line_summary as (
    select
      count(*) filter (where lb.line_status not in ('cancelled', 'skipped')) as line_count,
      coalesce(sum(lb.quantity) filter (where lb.line_status not in ('cancelled', 'skipped')), 0)::bigint as unit_count,
      count(*) filter (where lb.line_status in ('pending', 'partially_fulfilled')) as pending_line_count,
      count(*) filter (where lb.line_status = 'cancelled') as cancelled_line_count
    from line_base lb
  ),
  return_summary as (
    select
      count(*) filter (where rb.status <> 'cancelled') as return_count,
      count(*) filter (where rb.status not in ('closed', 'cancelled')) as open_return_count
    from return_base rb
  ),
  kind_rows as (
    select
      lb.category_label,
      count(*) as line_count,
      coalesce(sum(lb.quantity), 0)::bigint as unit_count,
      round(coalesce(sum(lb.total_price), 0), 2) as gross_sales
    from line_base lb
    where lb.line_status not in ('cancelled', 'skipped')
    group by lb.category_label
    order by gross_sales desc, unit_count desc, line_count desc
    limit 8
  ),
  top_item_rows as (
    select
      lb.item_title,
      max(lb.item_number) as item_number,
      count(*) as purchase_count,
      coalesce(sum(lb.quantity), 0)::bigint as unit_count,
      round(coalesce(sum(lb.total_price), 0), 2) as gross_sales,
      max(lb.purchase_at) as last_purchase_at
    from line_base lb
    where lb.line_status not in ('cancelled', 'skipped')
    group by lb.item_title
    order by gross_sales desc, unit_count desc, purchase_count desc
    limit 8
  ),
  recent_order_rows as (
    select
      bo.id,
      bo.order_number,
      bo.status,
      bo.purchase_at,
      bo.ship_by_date,
      round(bo.total_price, 2) as total_price,
      round(bo.net_payout, 2) as net_payout,
      (
        select count(*)
        from line_base lb
        where lb.order_id = bo.id
      ) as line_count,
      (
        select coalesce(sum(lb.quantity), 0)::bigint
        from line_base lb
        where lb.order_id = bo.id
      ) as unit_count,
      (
        select coalesce(jsonb_agg(x.item_title order by x.item_title), '[]'::jsonb)
        from (
          select distinct lb.item_title
          from line_base lb
          where lb.order_id = bo.id
          order by lb.item_title
          limit 3
        ) x
      ) as item_titles
    from buyer_orders bo
    order by bo.purchase_at desc nulls last, bo.order_number desc
    limit 8
  ),
  recent_return_rows as (
    select
      rb.ebay_return_id,
      rb.order_number,
      rb.return_reason,
      rb.status,
      rb.opened_at,
      rb.closed_at,
      rb.request_amount,
      rb.buyer_comment
    from return_base rb
    order by rb.opened_at desc nulls last, rb.order_number desc
    limit 6
  )
  select jsonb_build_object(
    'buyerUsername', os.buyer_username,
    'buyerName', os.buyer_name,
    'summary', jsonb_build_object(
      'orderCount', coalesce(os.order_count, 0),
      'pendingOrderCount', coalesce(os.pending_order_count, 0),
      'fulfilledOrderCount', coalesce(os.fulfilled_order_count, 0),
      'cancelledOrderCount', coalesce(os.cancelled_order_count, 0),
      'lineCount', coalesce(ls.line_count, 0),
      'unitCount', coalesce(ls.unit_count, 0),
      'pendingLineCount', coalesce(ls.pending_line_count, 0),
      'cancelledLineCount', coalesce(ls.cancelled_line_count, 0),
      'grossSales', coalesce(os.gross_sales, 0),
      'netPayout', coalesce(os.net_payout, 0),
      'shippingTotal', coalesce(os.shipping_total, 0),
      'avgOrderValue', round(coalesce(os.gross_sales, 0) / nullif(os.order_count, 0), 2),
      'returnCount', coalesce(rs.return_count, 0),
      'openReturnCount', coalesce(rs.open_return_count, 0),
      'returnRate', round(coalesce(rs.return_count, 0)::numeric / nullif(os.order_count, 0), 4),
      'firstPurchaseAt', os.first_purchase_at,
      'lastPurchaseAt', os.last_purchase_at
    ),
    'itemKinds', coalesce((
      select jsonb_agg(jsonb_build_object(
        'label', kr.category_label,
        'lineCount', kr.line_count,
        'unitCount', kr.unit_count,
        'grossSales', kr.gross_sales
      ) order by kr.gross_sales desc, kr.unit_count desc)
      from kind_rows kr
    ), '[]'::jsonb),
    'topItems', coalesce((
      select jsonb_agg(jsonb_build_object(
        'title', tir.item_title,
        'itemNumber', tir.item_number,
        'purchaseCount', tir.purchase_count,
        'unitCount', tir.unit_count,
        'grossSales', tir.gross_sales,
        'lastPurchaseAt', tir.last_purchase_at
      ) order by tir.gross_sales desc, tir.unit_count desc)
      from top_item_rows tir
    ), '[]'::jsonb),
    'recentOrders', coalesce((
      select jsonb_agg(jsonb_build_object(
        'orderNumber', ror.order_number,
        'status', ror.status,
        'purchaseAt', ror.purchase_at,
        'shipByDate', ror.ship_by_date,
        'totalPrice', ror.total_price,
        'netPayout', ror.net_payout,
        'lineCount', ror.line_count,
        'unitCount', ror.unit_count,
        'itemTitles', ror.item_titles
      ) order by ror.purchase_at desc nulls last)
      from recent_order_rows ror
    ), '[]'::jsonb),
    'recentReturns', coalesce((
      select jsonb_agg(jsonb_build_object(
        'returnId', rrr.ebay_return_id,
        'orderNumber', rrr.order_number,
        'reason', rrr.return_reason,
        'status', rrr.status,
        'openedAt', rrr.opened_at,
        'closedAt', rrr.closed_at,
        'requestAmount', rrr.request_amount,
        'buyerComment', rrr.buyer_comment
      ) order by rrr.opened_at desc nulls last)
      from recent_return_rows rrr
    ), '[]'::jsonb)
  )
  into v_result
  from order_summary os
  cross join line_summary ls
  cross join return_summary rs;

  return coalesce(v_result, jsonb_build_object(
    'buyerUsername', nullif(btrim(_buyer_username), ''),
    'buyerName', null,
    'summary', jsonb_build_object(
      'orderCount', 0,
      'lineCount', 0,
      'unitCount', 0,
      'grossSales', 0,
      'netPayout', 0,
      'returnCount', 0,
      'openReturnCount', 0
    ),
    'itemKinds', '[]'::jsonb,
    'topItems', '[]'::jsonb,
    'recentOrders', '[]'::jsonb,
    'recentReturns', '[]'::jsonb
  ));
end;
$$;

revoke all on function public.get_ebay_buyer_insights(text, integer) from public;
grant execute on function public.get_ebay_buyer_insights(text, integer) to authenticated;
