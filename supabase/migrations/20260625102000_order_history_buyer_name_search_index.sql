-- Speed up Order History all-date buyer-name lookups.
create extension if not exists pg_trgm with schema extensions;

create index if not exists ebay_orders_buyer_name_trgm_idx
  on public.ebay_orders using gin (buyer_name extensions.gin_trgm_ops)
  where buyer_name is not null;
