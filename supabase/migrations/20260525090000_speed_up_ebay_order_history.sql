-- Speed up large Order History ranges. The UI filters closed eBay order lines by
-- fulfilled_at and line_status, then joins back to ebay_orders.
create index if not exists ebay_order_lines_closed_history_idx
  on public.ebay_order_lines (fulfilled_at desc, line_status, order_id)
  where fulfilled_at is not null
    and line_status in ('fulfilled', 'cancelled', 'skipped');

create index if not exists ebay_order_lines_order_id_idx
  on public.ebay_order_lines (order_id);

