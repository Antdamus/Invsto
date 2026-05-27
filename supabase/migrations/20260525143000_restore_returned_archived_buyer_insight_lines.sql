-- Returned orders can be auto-hidden from the pending queue as skipped/archive
-- when eBay no longer reports them as paid awaiting shipment. Buyer Insight
-- still needs to count those returned lines. Keep true duplicate skipped lines
-- excluded, but classify skipped/archive lines with return cases as returns.

create or replace function public.get_ebay_buyer_value_line_breakdown(
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
    raise exception 'Not allowed to view eBay buyer line breakdown' using errcode = '42501';
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
      coalesce(eo.total_price, 0)::numeric as order_total,
      coalesce(eo.net_payout, eo.total_price, 0)::numeric as order_net_payout
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
  raw_lines as (
    select
      eol.id,
      eol.order_id,
      bo.order_number,
      bo.status as order_status,
      bo.purchase_at,
      bo.ship_by_date,
      bo.order_total,
      bo.order_net_payout,
      eol.item_number,
      eol.transaction_id,
      eol.custom_label,
      eol.item_title,
      eol.line_status,
      coalesce(eol.quantity, 0)::integer as quantity,
      coalesce(eol.sold_for, 0)::numeric as sold_for,
      coalesce(eol.shipping_and_handling, 0)::numeric as line_shipping,
      coalesce(eol.total_price, 0)::numeric as line_total,
      coalesce(eol.net_payout, eol.total_price, 0)::numeric as line_net_payout,
      (
        eol.line_status = 'skipped'
        and coalesce(eol.notes, '') ilike '%Auto-hidden duplicate eBay line after API order sync%'
      ) as is_duplicate_skipped_line
    from buyer_orders bo
    join public.ebay_order_lines eol on eol.order_id = bo.id
  ),
  line_order_totals as (
    select
      rl.order_id,
      greatest(coalesce(sum(nullif(rl.line_total, 0)), 0), 0)::numeric as line_total_sum
    from raw_lines rl
    where not rl.is_duplicate_skipped_line
    group by rl.order_id
  ),
  line_rows as (
    select
      rl.*,
      coalesce(rabo.return_count, 0) as return_count,
      coalesce(rabo.open_return_count, 0) as open_return_count,
      coalesce(rabo.returned_amount, 0) as order_returned_amount,
      greatest(0::numeric, round(rl.order_total - coalesce(rabo.returned_amount, 0), 2)) as order_retained_amount,
      coalesce(rabo.return_details, '[]'::jsonb) as return_details,
      case
        when rl.order_status = 'cancelled' or rl.line_status = 'cancelled' then 'cancelled'
        when rabo.order_number is not null and not rl.is_duplicate_skipped_line then 'return'
        when rl.line_status = 'skipped' or rl.order_status = 'archived' then 'archived'
        when rl.order_status in ('pending', 'partially_fulfilled') or rl.line_status in ('pending', 'partially_fulfilled') then 'pending'
        when rl.order_status = 'fulfilled' or rl.line_status = 'fulfilled' then 'successful'
        else 'unknown'
      end as item_state,
      case
        when rabo.order_number is not null and not rl.is_duplicate_skipped_line and lot.line_total_sum > 0
          then round(rabo.returned_amount * (rl.line_total / lot.line_total_sum), 2)
        when rabo.order_number is not null and not rl.is_duplicate_skipped_line
          then rabo.returned_amount
        else 0::numeric
      end as line_returned_amount
    from raw_lines rl
    left join line_order_totals lot on lot.order_id = rl.order_id
    left join return_amounts_by_order rabo on rabo.order_number = rl.order_number
  )
  select jsonb_build_object(
    'lineBreakdown', coalesce(jsonb_agg(jsonb_build_object(
      'lineId', lr.id,
      'orderId', lr.order_id,
      'orderNumber', lr.order_number,
      'purchaseAt', lr.purchase_at,
      'shipByDate', lr.ship_by_date,
      'orderStatus', lr.order_status,
      'lineStatus', lr.line_status,
      'itemState', lr.item_state,
      'itemNumber', lr.item_number,
      'transactionId', lr.transaction_id,
      'customLabel', lr.custom_label,
      'title', lr.item_title,
      'quantity', lr.quantity,
      'soldFor', round(lr.sold_for, 2),
      'lineShipping', round(lr.line_shipping, 2),
      'lineTotal', round(lr.line_total, 2),
      'lineNetPayout', round(lr.line_net_payout, 2),
      'orderTotal', round(lr.order_total, 2),
      'orderNetPayout', round(lr.order_net_payout, 2),
      'orderReturnedAmount', round(lr.order_returned_amount, 2),
      'orderRetainedAmount', round(lr.order_retained_amount, 2),
      'lineReturnedAmount', round(lr.line_returned_amount, 2),
      'lineRetainedAmount', greatest(0::numeric, round(lr.line_total - lr.line_returned_amount, 2)),
      'returnCount', lr.return_count,
      'openReturnCount', lr.open_return_count,
      'returnDetails', lr.return_details
    ) order by lr.purchase_at desc nulls last, lr.order_number desc, lr.item_title), '[]'::jsonb)
  )
  into v_result
  from line_rows lr;

  return coalesce(v_result, jsonb_build_object('lineBreakdown', '[]'::jsonb));
end;
$$;

revoke all on function public.get_ebay_buyer_value_line_breakdown(text, integer) from public;
grant execute on function public.get_ebay_buyer_value_line_breakdown(text, integer) to authenticated;
