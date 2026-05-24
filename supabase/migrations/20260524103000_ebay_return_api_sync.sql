-- Server-side eBay return intake audit.
-- The edge function writes through the service role; authenticated users only
-- need read access for reporting/debug history in the app.

create table if not exists public.ebay_return_sync_runs (
  id uuid primary key default gen_random_uuid(),
  dry_run boolean not null default true,
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed')),
  returns_seen integer not null default 0,
  cases_matched integer not null default 0,
  cases_unmatched integer not null default 0,
  tasks_created integer not null default 0,
  tasks_updated integer not null default 0,
  messages_imported integer not null default 0,
  files_seen integer not null default 0,
  errors integer not null default 0,
  warnings jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

alter table public.ebay_return_sync_runs enable row level security;

drop policy if exists "ebay_return_sync_runs_inventory_staff_select" on public.ebay_return_sync_runs;
create policy "ebay_return_sync_runs_inventory_staff_select"
on public.ebay_return_sync_runs
for select
to authenticated
using (public.can_manage_inventory());

grant select on table public.ebay_return_sync_runs to authenticated;

create index if not exists ebay_return_sync_runs_started_idx
  on public.ebay_return_sync_runs(started_at desc);

create index if not exists ebay_return_cases_return_id_idx
  on public.ebay_return_cases(ebay_return_id)
  where ebay_return_id is not null;

create index if not exists ebay_return_cases_order_number_idx
  on public.ebay_return_cases(order_number, opened_at desc)
  where order_number is not null;

create index if not exists ebay_return_tasks_due_idx
  on public.ebay_return_tasks(due_at nulls last, created_at desc)
  where status in ('open', 'assigned', 'in_progress', 'blocked', 'deferred');
