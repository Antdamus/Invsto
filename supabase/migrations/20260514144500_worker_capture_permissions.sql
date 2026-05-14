-- Allow active inventory workers to request and follow camera capture jobs.
-- The add-item assisted workflow and stock photo manager both create capture_jobs.

create table if not exists public.capture_stations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.capture_jobs (
  id uuid primary key default gen_random_uuid(),
  station_id uuid references public.capture_stations(id) on delete set null,
  status text not null default 'queued',
  requested_at timestamptz not null default now(),
  requested_by uuid references auth.users(id) on delete set null default auth.uid(),
  requested_by_email text,
  storage_bucket text,
  storage_path text,
  capture_completed_at timestamptz,
  upload_completed_at timestamptz,
  mime_type text,
  file_size_bytes bigint,
  failure_code text,
  failure_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.capture_job_photos (
  id uuid primary key default gen_random_uuid(),
  capture_job_id uuid references public.capture_jobs(id) on delete cascade,
  sort_order integer not null default 0,
  is_primary boolean not null default false,
  storage_bucket text,
  storage_path text,
  file_size_bytes bigint,
  image_width integer,
  image_height integer,
  mime_type text,
  label text,
  created_at timestamptz not null default now()
);

alter table public.capture_jobs
  add column if not exists requested_by uuid references auth.users(id) on delete set null default auth.uid(),
  add column if not exists requested_by_email text,
  add column if not exists storage_bucket text,
  add column if not exists storage_path text,
  add column if not exists capture_completed_at timestamptz,
  add column if not exists upload_completed_at timestamptz,
  add column if not exists mime_type text,
  add column if not exists file_size_bytes bigint,
  add column if not exists failure_code text,
  add column if not exists failure_message text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

alter table public.capture_job_photos
  add column if not exists sort_order integer not null default 0,
  add column if not exists is_primary boolean not null default false,
  add column if not exists storage_bucket text,
  add column if not exists storage_path text,
  add column if not exists file_size_bytes bigint,
  add column if not exists image_width integer,
  add column if not exists image_height integer,
  add column if not exists mime_type text,
  add column if not exists label text,
  add column if not exists created_at timestamptz not null default now();

create index if not exists capture_jobs_station_requested_idx
  on public.capture_jobs(station_id, requested_at desc);

create index if not exists capture_jobs_status_idx
  on public.capture_jobs(status, requested_at desc);

create index if not exists capture_job_photos_job_sort_idx
  on public.capture_job_photos(capture_job_id, sort_order);

alter table public.capture_stations enable row level security;
alter table public.capture_jobs enable row level security;
alter table public.capture_job_photos enable row level security;

drop policy if exists "capture_stations_select_inventory_staff" on public.capture_stations;
create policy "capture_stations_select_inventory_staff"
on public.capture_stations
for select
to authenticated
using (public.can_manage_inventory());

drop policy if exists "capture_stations_admin_insert" on public.capture_stations;
create policy "capture_stations_admin_insert"
on public.capture_stations
for insert
to authenticated
with check (public.is_admin());

drop policy if exists "capture_stations_admin_update" on public.capture_stations;
create policy "capture_stations_admin_update"
on public.capture_stations
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "capture_jobs_select_inventory_staff" on public.capture_jobs;
create policy "capture_jobs_select_inventory_staff"
on public.capture_jobs
for select
to authenticated
using (public.can_manage_inventory());

drop policy if exists "capture_jobs_insert_inventory_staff" on public.capture_jobs;
create policy "capture_jobs_insert_inventory_staff"
on public.capture_jobs
for insert
to authenticated
with check (public.can_manage_inventory());

drop policy if exists "capture_jobs_update_inventory_staff" on public.capture_jobs;
create policy "capture_jobs_update_inventory_staff"
on public.capture_jobs
for update
to authenticated
using (public.can_manage_inventory())
with check (public.can_manage_inventory());

drop policy if exists "capture_job_photos_select_inventory_staff" on public.capture_job_photos;
create policy "capture_job_photos_select_inventory_staff"
on public.capture_job_photos
for select
to authenticated
using (public.can_manage_inventory());

drop policy if exists "capture_job_photos_insert_inventory_staff" on public.capture_job_photos;
create policy "capture_job_photos_insert_inventory_staff"
on public.capture_job_photos
for insert
to authenticated
with check (public.can_manage_inventory());

drop policy if exists "capture_job_photos_update_inventory_staff" on public.capture_job_photos;
create policy "capture_job_photos_update_inventory_staff"
on public.capture_job_photos
for update
to authenticated
using (public.can_manage_inventory())
with check (public.can_manage_inventory());

grant select on table public.capture_stations to authenticated;
grant select, insert, update on table public.capture_jobs to authenticated;
grant select, insert, update on table public.capture_job_photos to authenticated;
