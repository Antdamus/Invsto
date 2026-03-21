create or replace function public.is_active_employee()
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
  );
$$;

create table if not exists public.capture_stations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  active boolean not null default true,
  assigned_employee_id uuid null references public.employees(id) on delete set null,
  device_label text null,
  ios_device_identifier text null,
  last_seen_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint capture_stations_name_not_blank check (length(btrim(name)) > 0),
  constraint capture_stations_ios_device_identifier_key unique (ios_device_identifier)
);

create table if not exists public.capture_jobs (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid null references public.employees(id) on delete set null,
  station_id uuid not null references public.capture_stations(id) on delete restrict,
  status text not null default 'queued',
  requested_at timestamptz not null default now(),
  claimed_at timestamptz null,
  capture_started_at timestamptz null,
  capture_completed_at timestamptz null,
  upload_completed_at timestamptz null,
  storage_bucket text null,
  storage_path text null,
  file_size_bytes bigint null,
  mime_type text null,
  failure_code text null,
  failure_message text null,
  control_payload jsonb null,
  result_payload jsonb null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint capture_jobs_status_check check (
    status = any (
      array[
        'queued',
        'assigned',
        'capturing',
        'uploading',
        'completed',
        'failed',
        'canceled'
      ]
    )
  ),
  constraint capture_jobs_storage_pair_check check (
    (storage_bucket is null and storage_path is null)
    or (storage_bucket is not null and storage_path is not null)
  ),
  constraint capture_jobs_failure_pair_check check (
    (failure_code is null and failure_message is null)
    or failure_code is not null
  )
);

drop trigger if exists trg_capture_stations_updated_at on public.capture_stations;
create trigger trg_capture_stations_updated_at
before update on public.capture_stations
for each row execute function public.set_updated_at();

drop trigger if exists trg_capture_jobs_updated_at on public.capture_jobs;
create trigger trg_capture_jobs_updated_at
before update on public.capture_jobs
for each row execute function public.set_updated_at();

create index if not exists idx_capture_stations_active_name
on public.capture_stations (active, name);

create index if not exists idx_capture_stations_assigned_employee
on public.capture_stations (assigned_employee_id);

create index if not exists idx_capture_jobs_station_status_requested_at
on public.capture_jobs (station_id, status, requested_at desc);

create index if not exists idx_capture_jobs_status_requested_at
on public.capture_jobs (status, requested_at desc);

create index if not exists idx_capture_jobs_requested_by
on public.capture_jobs (requested_by);

grant select, insert, update, delete on table public.capture_stations to authenticated;
grant select, insert, update, delete on table public.capture_jobs to authenticated;

alter table public.capture_stations enable row level security;
alter table public.capture_jobs enable row level security;

alter table public.capture_stations replica identity full;
alter table public.capture_jobs replica identity full;

drop policy if exists "capture_stations_read_active_employees" on public.capture_stations;
create policy "capture_stations_read_active_employees"
on public.capture_stations
for select
to authenticated
using (public.is_active_employee());

drop policy if exists "capture_stations_write_admin_manager" on public.capture_stations;
create policy "capture_stations_write_admin_manager"
on public.capture_stations
for all
to authenticated
using (
  exists (
    select 1
    from public.employees e
    where e.user_id = auth.uid()
      and e.active = true
      and e.role in ('admin', 'manager')
  )
)
with check (
  exists (
    select 1
    from public.employees e
    where e.user_id = auth.uid()
      and e.active = true
      and e.role in ('admin', 'manager')
  )
);

drop policy if exists "capture_jobs_read_active_employees" on public.capture_jobs;
create policy "capture_jobs_read_active_employees"
on public.capture_jobs
for select
to authenticated
using (public.is_active_employee());

drop policy if exists "capture_jobs_write_admin_manager" on public.capture_jobs;
create policy "capture_jobs_write_admin_manager"
on public.capture_jobs
for all
to authenticated
using (
  exists (
    select 1
    from public.employees e
    where e.user_id = auth.uid()
      and e.active = true
      and e.role in ('admin', 'manager')
  )
)
with check (
  exists (
    select 1
    from public.employees e
    where e.user_id = auth.uid()
      and e.active = true
      and e.role in ('admin', 'manager')
  )
);
