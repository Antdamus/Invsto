-- Track on-demand deep eBay buyer history scans so the UI can show whether a
-- buyer has already had the expensive 2-year lookup.

create table if not exists public.ebay_buyer_history_syncs (
  buyer_key text primary key,
  buyer_username text not null,
  status text not null default 'completed'
    check (status in ('running', 'completed', 'failed')),
  days_back integer not null default 730,
  max_scanned_orders integer not null default 2500,
  scanned_orders integer not null default 0,
  matched_orders integer not null default 0,
  orders_upserted integer not null default 0,
  lines_upserted integer not null default 0,
  skipped_new_open_orders integer not null default 0,
  windows_scanned integer not null default 0,
  last_started_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ebay_buyer_history_syncs_last_success_idx
  on public.ebay_buyer_history_syncs (last_success_at desc nulls last);

create or replace function public.touch_ebay_buyer_history_syncs_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists touch_ebay_buyer_history_syncs_updated_at
  on public.ebay_buyer_history_syncs;

create trigger touch_ebay_buyer_history_syncs_updated_at
before update on public.ebay_buyer_history_syncs
for each row
execute function public.touch_ebay_buyer_history_syncs_updated_at();

alter table public.ebay_buyer_history_syncs enable row level security;

drop policy if exists "Inventory managers can read eBay buyer scan metadata"
  on public.ebay_buyer_history_syncs;

create policy "Inventory managers can read eBay buyer scan metadata"
on public.ebay_buyer_history_syncs
for select
to authenticated
using (public.can_manage_inventory());

grant select on public.ebay_buyer_history_syncs to authenticated;
grant all on public.ebay_buyer_history_syncs to service_role;
