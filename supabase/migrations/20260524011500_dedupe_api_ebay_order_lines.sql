-- Collapse duplicate open eBay order lines created when the API sync sees a
-- line that was already imported through the older CSV/extension workflow.
-- The oldest open line stays visible; later exact duplicates are hidden from
-- the pending queue as skipped without removing inventory.

with ranked as (
  select
    l.id,
    row_number() over (
      partition by
        l.order_id,
        coalesce(l.item_number, ''),
        lower(regexp_replace(btrim(coalesce(l.item_title, '')), '\s+', ' ', 'g')),
        coalesce(l.quantity, 1)
      order by l.created_at asc, l.id asc
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
      'Auto-hidden duplicate eBay line after API order sync matched an existing pending line.'
    ),
    updated_at = now()
from ranked r
where l.id = r.id
  and r.duplicate_count > 1
  and r.duplicate_rank > 1;
