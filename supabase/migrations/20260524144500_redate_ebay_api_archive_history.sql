-- eBay's fulfillment API can update lastModifiedDate long after an order was
-- actually bought, shipped, or cancelled. Early archive imports used that value
-- as ebay_order_lines.fulfilled_at, which made old imported orders appear as
-- today's work in Order History. Re-date API-imported history rows to the most
-- stable business date we have: cancel close date for cancellations, otherwise
-- the paid/sale date.

with api_history_lines as (
  select
    l.id,
    l.fulfilled_at as previous_fulfilled_at,
    case
      when l.line_status = 'cancelled' then coalesce(
        nullif(o.raw_payload #>> '{order,cancelStatus,cancelCloseDate}', '')::timestamptz,
        nullif(o.raw_payload #>> '{order,cancelStatus,cancelCompletedDate}', '')::timestamptz,
        nullif(o.raw_payload #>> '{order,cancelStatus,cancelRequestDate}', '')::timestamptz,
        nullif(o.raw_payload #>> '{order,cancelStatus,cancelDate}', '')::timestamptz,
        o.paid_on_date,
        o.sale_date,
        nullif(o.raw_payload #>> '{order,creationDate}', '')::timestamptz,
        l.fulfilled_at
      )
      else coalesce(
        o.paid_on_date,
        o.sale_date,
        nullif(o.raw_payload #>> '{order,paymentSummary,payments,0,paymentDate}', '')::timestamptz,
        nullif(o.raw_payload #>> '{order,creationDate}', '')::timestamptz,
        l.fulfilled_at
      )
    end as corrected_fulfilled_at
  from public.ebay_order_lines l
  join public.ebay_orders o on o.id = l.order_id
  where l.line_status in ('fulfilled', 'cancelled', 'skipped')
    and coalesce(l.raw_payload->>'source', o.raw_payload->>'source', '') in (
      'ebay_account_history_sync',
      'ebay_buyer_history_sync'
    )
)
update public.ebay_order_lines l
set
  fulfilled_at = api_history_lines.corrected_fulfilled_at,
  raw_payload = coalesce(l.raw_payload, '{}'::jsonb)
    || jsonb_build_object(
      'history_date_corrected_at', now(),
      'previous_fulfilled_at', api_history_lines.previous_fulfilled_at
    )
from api_history_lines
where l.id = api_history_lines.id
  and api_history_lines.corrected_fulfilled_at is not null
  and l.fulfilled_at is distinct from api_history_lines.corrected_fulfilled_at;
