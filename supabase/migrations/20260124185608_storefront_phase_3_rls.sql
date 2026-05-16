-- ==========================================================
-- Phase 3: RLS + policies for storefront publishing system
-- - Public reads ONLY via rpc_storefront_catalog()
-- - Admins manage listings + spot prices
-- ==========================================================

-- ---------- Helper: is_admin() ----------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.employees e
    where e.user_id = auth.uid()
      and e.active = true
      and e.role = 'admin'
  );
$$;
-- ---------- Table grants (explicit hardening) ----------
-- Ensure anon cannot read/write these tables directly
revoke all on table public.sales_channels from anon;
revoke all on table public.storefront_listings from anon;
revoke all on table public.metal_spot_prices from anon;
-- Allow authenticated users to interact (RLS will still restrict rows/ops)
grant select on table public.sales_channels to authenticated;
grant select on table public.storefront_listings to authenticated;
grant select on table public.metal_spot_prices to authenticated;
grant insert, update, delete on table public.sales_channels to authenticated;
grant insert, update, delete on table public.storefront_listings to authenticated;
grant insert, update, delete on table public.metal_spot_prices to authenticated;
-- ---------- Enable RLS ----------
alter table public.sales_channels enable row level security;
alter table public.storefront_listings enable row level security;
alter table public.metal_spot_prices enable row level security;
-- ---------- sales_channels policies ----------
drop policy if exists "sales_channels_read_staff" on public.sales_channels;
create policy "sales_channels_read_staff"
on public.sales_channels
for select
to authenticated
using (
  exists (
    select 1 from public.employees e
    where e.user_id = auth.uid()
      and e.active = true
  )
);
drop policy if exists "sales_channels_write_admin" on public.sales_channels;
create policy "sales_channels_write_admin"
on public.sales_channels
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());
-- ---------- storefront_listings policies ----------
drop policy if exists "storefront_listings_read_staff" on public.storefront_listings;
create policy "storefront_listings_read_staff"
on public.storefront_listings
for select
to authenticated
using (
  exists (
    select 1 from public.employees e
    where e.user_id = auth.uid()
      and e.active = true
  )
);
drop policy if exists "storefront_listings_write_admin" on public.storefront_listings;
create policy "storefront_listings_write_admin"
on public.storefront_listings
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());
-- ---------- metal_spot_prices policies ----------
drop policy if exists "metal_spot_prices_read_staff" on public.metal_spot_prices;
create policy "metal_spot_prices_read_staff"
on public.metal_spot_prices
for select
to authenticated
using (
  exists (
    select 1 from public.employees e
    where e.user_id = auth.uid()
      and e.active = true
  )
);
drop policy if exists "metal_spot_prices_write_admin" on public.metal_spot_prices;
create policy "metal_spot_prices_write_admin"
on public.metal_spot_prices
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());
