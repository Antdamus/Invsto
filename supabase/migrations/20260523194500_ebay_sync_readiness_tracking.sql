-- Durable eBay sync/readiness state for Stock-page repair workflows.
-- This lets dry runs, syncs, and publish attempts leave item-level status behind
-- so admins can filter and fix problem inventory after the modal is closed.

alter table public.ebay_inventory_links
  add column if not exists publish_ready boolean,
  add column if not exists last_warnings text[] not null default '{}'::text[],
  add column if not exists last_status_detail text,
  add column if not exists last_category_id text,
  add column if not exists last_category_source text,
  add column if not exists last_image_count integer,
  add column if not exists last_quantity integer,
  add column if not exists last_price numeric(12, 2),
  add column if not exists last_checked_at timestamptz,
  add column if not exists last_run_id uuid references public.ebay_inventory_sync_runs(id) on delete set null,
  add column if not exists last_sync_mode text;

create index if not exists ebay_inventory_links_publish_ready_idx
  on public.ebay_inventory_links(publish_ready, updated_at desc);

create index if not exists ebay_inventory_links_last_checked_idx
  on public.ebay_inventory_links(last_checked_at desc);

create index if not exists ebay_inventory_links_last_run_idx
  on public.ebay_inventory_links(last_run_id);
