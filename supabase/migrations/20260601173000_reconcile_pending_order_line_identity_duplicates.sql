-- Hide mixed-source duplicate pending eBay lines without deleting their audit trail.
-- These can happen when the eBay API and the older report/CSV flow describe the
-- same logical line with different transaction ids.

with ranked as (
  select
    l.id,
    row_number() over (
      partition by
        l.order_id,
        coalesce(l.item_number, ''),
        lower(regexp_replace(btrim(coalesce(l.item_title, '')), '\s+', ' ', 'g')),
        coalesce(l.quantity, 1)
      order by
        case when l.raw_payload->>'source' = 'ebay_fulfillment_api' then 0 else 1 end,
        case when nullif(btrim(coalesce(l.transaction_id, '')), '') is not null then 0 else 1 end,
        l.created_at asc,
        l.id asc
    ) as duplicate_rank,
    count(*) over (
      partition by
        l.order_id,
        coalesce(l.item_number, ''),
        lower(regexp_replace(btrim(coalesce(l.item_title, '')), '\s+', ' ', 'g')),
        coalesce(l.quantity, 1)
    ) as duplicate_count
  from public.ebay_order_lines l
  where l.line_status in ('pending', 'partially_fulfilled')
    and coalesce(l.fulfilled_quantity, 0) = 0
    and l.stock_transaction_id is null
)
update public.ebay_order_lines l
set line_status = 'skipped',
    notes = concat_ws(
      E'\n',
      nullif(l.notes, ''),
      'Auto-hidden duplicate eBay pending line after matching the same order, item, title, and quantity across import sources.'
    ),
    updated_at = now()
from ranked r
where l.id = r.id
  and r.duplicate_count > 1
  and r.duplicate_rank > 1;
