-- ============================================
-- A1) Reservations (per item_type, not per location)
-- ============================================

create table if not exists public.storefront_reservations (
  id uuid primary key default gen_random_uuid(),
  status text not null check (status in ('active','expired','paid','canceled')),
  user_id uuid null,                       -- supabase auth user id (optional)
  anon_session_id text null,               -- your anonymous session id (optional)
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,         -- now() + interval '10 minutes'
  stripe_checkout_session_id text null,
  stripe_payment_intent_id text null,

  -- at least one identity must be present
  constraint reservation_identity_chk check (
    (user_id is not null) or (anon_session_id is not null)
  )
);
create index if not exists storefront_reservations_status_expires_idx
  on public.storefront_reservations (status, expires_at);
create table if not exists public.storefront_reservation_items (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.storefront_reservations(id) on delete cascade,
  item_type_id uuid not null references public.item_types(id) on delete restrict,
  qty integer not null check (qty > 0),

  -- prevent duplicates inside a reservation
  constraint reservation_item_unique unique (reservation_id, item_type_id)
);
create index if not exists storefront_reservation_items_item_idx
  on public.storefront_reservation_items (item_type_id);
-- ============================================
-- A1) Idempotency store for Stripe webhooks (later)
-- ============================================

create table if not exists public.storefront_stripe_events (
  id uuid primary key default gen_random_uuid(),
  stripe_event_id text not null unique,
  event_type text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz null,
  reservation_id uuid null references public.storefront_reservations(id) on delete set null,
  raw jsonb null
);
-- ============================================
-- A1) Availability-to-sell RPC (read-only)
-- ============================================
-- Assumptions:
--  - item_stock_locations has columns: item_id (uuid), quantity (int)
--  - item_types id is the item_type_id used in cart

create or replace function public.rpc_storefront_availability(p_item_type_ids uuid[])
returns table(
  item_type_id uuid,
  on_hand integer,
  reserved_active integer,
  available_to_sell integer
)
language sql
stable
as $$
with onhand as (
  select
    isl.item_id as item_type_id,
    coalesce(sum(isl.quantity), 0)::int as on_hand
  from public.item_stock_locations isl
  where isl.item_id = any(p_item_type_ids)
  group by isl.item_id
),
reserved as (
  select
    sri.item_type_id,
    coalesce(sum(sri.qty), 0)::int as reserved_active
  from public.storefront_reservation_items sri
  join public.storefront_reservations r
    on r.id = sri.reservation_id
  where sri.item_type_id = any(p_item_type_ids)
    and r.status = 'active'
    and r.expires_at > now()
  group by sri.item_type_id
)
select
  ids.item_type_id,
  coalesce(o.on_hand, 0) as on_hand,
  coalesce(rv.reserved_active, 0) as reserved_active,
  greatest(coalesce(o.on_hand, 0) - coalesce(rv.reserved_active, 0), 0) as available_to_sell
from (
  select unnest(p_item_type_ids) as item_type_id
) ids
left join onhand o on o.item_type_id = ids.item_type_id
left join reserved rv on rv.item_type_id = ids.item_type_id;
$$;
-- ============================================
-- A1) Minimal permissions
-- ============================================
-- Availability is safe to expose:
grant execute on function public.rpc_storefront_availability(uuid[]) to anon, authenticated;
-- For reservations: we will CREATE reservations via an Edge Function (service role),
-- so we do NOT open inserts/updates to anon/auth here.;
