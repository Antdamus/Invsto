-- Seller commission/order-line fallback functions sort live sale lot items by
-- created_at, but the live sale lot item table was originally created with
-- scanned_at and packed_at only. Keep the sort column available and seed older
-- rows from scanned_at so sale item inserts do not fail.

alter table public.live_sale_lot_items
  add column if not exists created_at timestamptz;

update public.live_sale_lot_items
set created_at = coalesce(scanned_at, packed_at, now())
where created_at is null;

alter table public.live_sale_lot_items
  alter column created_at set default now(),
  alter column created_at set not null;
