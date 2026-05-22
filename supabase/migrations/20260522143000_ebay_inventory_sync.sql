-- Foundation for syncing internal inventory items to eBay Inventory API records/offers.
-- The Edge Function uses the service role key, but these policies let inventory staff
-- inspect sync state from future admin screens without exposing eBay secrets.

create table if not exists public.ebay_inventory_settings (
  id text primary key default 'default',
  marketplace_id text not null default 'EBAY_US',
  currency text not null default 'USD',
  merchant_location_key text not null default 'og-miami',
  default_category_id text not null default '261993',
  default_condition text not null default 'NEW_WITH_TAGS',
  listing_format text not null default 'FIXED_PRICE',
  payment_policy_id text,
  return_policy_id text,
  fulfillment_policy_id text,
  category_rules jsonb not null default '[
    { "match": ["bracelet", "tennis"], "categoryId": "261988" },
    { "match": ["pendant", "necklace"], "categoryId": "261993" }
  ]'::jsonb,
  enabled boolean not null default false,
  publish_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.ebay_inventory_settings (id)
values ('default')
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('public-ebay-photos', 'public-ebay-photos', true)
on conflict (id) do update set public = true;

create table if not exists public.ebay_inventory_links (
  item_type_id uuid primary key references public.item_types(id) on delete cascade,
  sku text not null unique,
  offer_id text,
  listing_id text,
  status text not null default 'pending'
    check (status in ('pending', 'synced', 'out_of_stock', 'skipped', 'error')),
  last_inventory_hash text,
  last_synced_at timestamptz,
  last_error text,
  last_payload jsonb,
  last_response jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ebay_inventory_links_status_idx
  on public.ebay_inventory_links(status, updated_at desc);

create table if not exists public.ebay_inventory_sync_runs (
  id uuid primary key default gen_random_uuid(),
  mode text not null default 'dry_run'
    check (mode in ('dry_run', 'sync', 'publish')),
  requested_item_ids uuid[] not null default '{}'::uuid[],
  total_items integer not null default 0,
  synced_items integer not null default 0,
  skipped_items integer not null default 0,
  error_items integer not null default 0,
  summary jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

alter table public.ebay_inventory_settings enable row level security;
alter table public.ebay_inventory_links enable row level security;
alter table public.ebay_inventory_sync_runs enable row level security;

grant select, update on public.ebay_inventory_settings to authenticated;
grant select on public.ebay_inventory_links to authenticated;
grant select on public.ebay_inventory_sync_runs to authenticated;

drop policy if exists "ebay_inventory_settings_inventory_staff_select" on public.ebay_inventory_settings;
create policy "ebay_inventory_settings_inventory_staff_select"
on public.ebay_inventory_settings
for select
using (public.can_manage_inventory());

drop policy if exists "ebay_inventory_settings_inventory_staff_update" on public.ebay_inventory_settings;
create policy "ebay_inventory_settings_inventory_staff_update"
on public.ebay_inventory_settings
for update
using (public.can_manage_inventory())
with check (public.can_manage_inventory());

drop policy if exists "ebay_inventory_links_inventory_staff_select" on public.ebay_inventory_links;
create policy "ebay_inventory_links_inventory_staff_select"
on public.ebay_inventory_links
for select
using (public.can_manage_inventory());

drop policy if exists "ebay_inventory_sync_runs_inventory_staff_select" on public.ebay_inventory_sync_runs;
create policy "ebay_inventory_sync_runs_inventory_staff_select"
on public.ebay_inventory_sync_runs
for select
using (public.can_manage_inventory());
