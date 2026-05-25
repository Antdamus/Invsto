-- Add an explicit return value breakdown for Buyer Insight.
-- The existing buyer insights RPC keeps returned purchases out of "prior orders";
-- this companion RPC explains partial returns as original value, returned amount,
-- and retained store value.

create or replace function public.get_ebay_buyer_return_value_breakdown(
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
    raise exception 'Not allowed to view eBay buyer return values' using errcode = '42501';
  end if;

  if v_buyer_key = '' then
    raise exception 'Buyer username is required' using errcode = '22023';
  end if;

  with buyer_orders as (
    select
      eo.id,
      nullif(btrim(eo.buyer_username), '') as buyer_username,
      eo.order_number,
      eo.status,
      coalesce(eo.sale_date, eo.paid_on_date, eo.imported_at) as purchase_at,
      eo.ship_by_date,
      coalesce(eo.total_price, 0)::numeric as total_price,
      coalesce(eo.net_payout, eo.total_price, 0)::numeric as net_payout
    from public.ebay_orders eo
    where lower(btrim(coalesce(eo.buyer_username, ''))) = v_buyer_key
      and (
        _days_back is null
        or coalesce(eo.sale_date, eo.paid_on_date, eo.imported_at) >= now() - make_interval(days => greatest(_days_back, 0))
      )
  ),
  return_raw as (
    select
      erc.ebay_return_id,
      erc.order_number,
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
  return_base as (
    select
      rr.*,
      case
        when regexp_replace(coalesce(rr.request_amount, ''), '[^0-9.\-]', '', 'g') ~ '^-?[0-9]+(\.[0-9]+)?$'
          then regexp_replace(coalesce(rr.request_amount, ''), '[^0-9.\-]', '', 'g')::numeric
        else 0::numeric
      end as request_amount_value
    from return_raw rr
  ),
  active_returns as (
    select *
    from return_base rb
    where lower(coalesce(rb.status, '')) <> 'cancelled'
      and nullif(btrim(coalesce(rb.order_number, '')), '') is not null
  ),
  return_amounts_by_order as (
    select
      ar.order_number,
      count(*) as return_count,
      count(*) filter (where lower(coalesce(ar.status, '')) <> 'closed') as open_return_count,
      round(coalesce(sum(ar.request_amount_value), 0), 2) as returned_amount,
      coalesce(jsonb_agg(jsonb_build_object(
        'returnId', ar.ebay_return_id,
        'reason', ar.return_reason,
        'status', ar.status,
        'openedAt', ar.opened_at,
        'closedAt', ar.closed_at,
        'requestAmount', ar.request_amount,
        'returnedAmount', ar.request_amount_value,
        'buyerComment', ar.buyer_comment
      ) order by ar.opened_at desc nulls last), '[]'::jsonb) as return_details
    from active_returns ar
    group by ar.order_number
  ),
  line_base as (
    select
      eol.order_id,
      bo.order_number,
      eol.item_title,
      coalesce(eol.quantity, 0)::integer as quantity
    from buyer_orders bo
    join public.ebay_order_lines eol on eol.order_id = bo.id
  ),
  returned_purchase_rows as (
    select
      bo.id,
      bo.order_number,
      bo.status,
      bo.purchase_at,
      bo.ship_by_date,
      round(bo.total_price, 2) as original_total,
      round(bo.net_payout, 2) as original_net_payout,
      rabo.return_count,
      rabo.open_return_count,
      rabo.returned_amount,
      greatest(0::numeric, round(bo.total_price - rabo.returned_amount, 2)) as retained_amount,
      greatest(0::numeric, round(bo.net_payout - rabo.returned_amount, 2)) as retained_net_payout,
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
      ) as item_titles,
      rabo.return_details
    from buyer_orders bo
    join return_amounts_by_order rabo on rabo.order_number = bo.order_number
    where bo.status not in ('cancelled', 'archived')
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
      rb.request_amount_value,
      rb.buyer_comment,
      round(bo.total_price, 2) as original_order_total,
      round(bo.net_payout, 2) as original_order_net_payout,
      greatest(0::numeric, round(coalesce(bo.total_price, 0) - rb.request_amount_value, 2)) as retained_order_value,
      (
        select coalesce(jsonb_agg(x.item_title order by x.item_title), '[]'::jsonb)
        from (
          select distinct lb.item_title
          from line_base lb
          where lb.order_number = rb.order_number
          order by lb.item_title
          limit 3
        ) x
      ) as item_titles
    from return_base rb
    left join buyer_orders bo on bo.order_number = rb.order_number
    order by rb.opened_at desc nulls last, rb.order_number desc
    limit 6
  )
  select jsonb_build_object(
    'returnedPurchases', coalesce((
      select jsonb_agg(jsonb_build_object(
        'orderNumber', rpr.order_number,
        'status', rpr.status,
        'purchaseAt', rpr.purchase_at,
        'shipByDate', rpr.ship_by_date,
        'originalTotal', rpr.original_total,
        'originalNetPayout', rpr.original_net_payout,
        'returnCount', rpr.return_count,
        'openReturnCount', rpr.open_return_count,
        'returnedAmount', rpr.returned_amount,
        'retainedAmount', rpr.retained_amount,
        'retainedNetPayout', rpr.retained_net_payout,
        'lineCount', rpr.line_count,
        'unitCount', rpr.unit_count,
        'itemTitles', rpr.item_titles,
        'returnDetails', rpr.return_details
      ) order by rpr.purchase_at desc nulls last)
      from returned_purchase_rows rpr
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
        'returnedAmount', rrr.request_amount_value,
        'buyerComment', rrr.buyer_comment,
        'originalOrderTotal', rrr.original_order_total,
        'originalOrderNetPayout', rrr.original_order_net_payout,
        'retainedOrderValue', rrr.retained_order_value,
        'itemTitles', rrr.item_titles
      ) order by rrr.opened_at desc nulls last)
      from recent_return_rows rrr
    ), '[]'::jsonb)
  )
  into v_result;

  return coalesce(v_result, jsonb_build_object(
    'returnedPurchases', '[]'::jsonb,
    'recentReturns', '[]'::jsonb
  ));
end;
$$;

revoke all on function public.get_ebay_buyer_return_value_breakdown(text, integer) from public;
grant execute on function public.get_ebay_buyer_return_value_breakdown(text, integer) to authenticated;
