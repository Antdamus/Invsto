-- Speed up Order History buyer lookups when searching across stored history.
create extension if not exists pg_trgm with schema extensions;

create index if not exists ebay_orders_buyer_username_trgm_idx
  on public.ebay_orders using gin (buyer_username extensions.gin_trgm_ops)
  where buyer_username is not null;
