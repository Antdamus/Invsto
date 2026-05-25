-- Track account-wide eBay history archive runs. This is separate from the
-- active pending-order queue so old API imports can be audited safely.

create table if not exists public.ebay_account_history_sync_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed')),
  dry_run boolean not null default false,
  days_back integer not null default 730,
  max_scanned_orders integer not null default 20000,
  scanned_orders integer not null default 0,
  matched_orders integer not null default 0,
  orders_upserted integer not null default 0,
  lines_upserted integer not null default 0,
  buyers_seen integer not null default 0,
  skipped_new_open_orders integer not null default 0,
  windows_scanned integer not null default 0,
  error text,
  raw_payload jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ebay_account_history_sync_runs_created_idx
  on public.ebay_account_history_sync_runs (created_at desc);

create or replace function public.touch_ebay_account_history_sync_runs_updated_at()
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

drop trigger if exists touch_ebay_account_history_sync_runs_updated_at
  on public.ebay_account_history_sync_runs;

create trigger touch_ebay_account_history_sync_runs_updated_at
before update on public.ebay_account_history_sync_runs
for each row
execute function public.touch_ebay_account_history_sync_runs_updated_at();

alter table public.ebay_account_history_sync_runs enable row level security;

drop policy if exists "Inventory managers can read eBay account scan runs"
  on public.ebay_account_history_sync_runs;

create policy "Inventory managers can read eBay account scan runs"
on public.ebay_account_history_sync_runs
for select
to authenticated
using (public.can_manage_inventory());

grant select on public.ebay_account_history_sync_runs to authenticated;
grant all on public.ebay_account_history_sync_runs to service_role;
