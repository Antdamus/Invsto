create table if not exists public.capture_job_photos (
  id uuid primary key default gen_random_uuid(),
  capture_job_id uuid not null references public.capture_jobs(id) on delete cascade,
  sort_order integer not null,
  is_primary boolean not null default false,
  storage_bucket text not null,
  storage_path text not null,
  file_size_bytes bigint not null,
  image_width integer null,
  image_height integer null,
  mime_type text not null,
  label text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint capture_job_photos_sort_order_check check (sort_order >= 0),
  constraint capture_job_photos_storage_bucket_not_blank check (length(btrim(storage_bucket)) > 0),
  constraint capture_job_photos_storage_path_not_blank check (length(btrim(storage_path)) > 0),
  constraint capture_job_photos_file_size_bytes_check check (file_size_bytes >= 0),
  constraint capture_job_photos_image_width_check check (image_width is null or image_width > 0),
  constraint capture_job_photos_image_height_check check (image_height is null or image_height > 0),
  constraint capture_job_photos_mime_type_not_blank check (length(btrim(mime_type)) > 0),
  constraint capture_job_photos_label_not_blank check (label is null or length(btrim(label)) > 0),
  constraint capture_job_photos_capture_job_sort_order_key unique (capture_job_id, sort_order)
);

drop trigger if exists trg_capture_job_photos_updated_at on public.capture_job_photos;
create trigger trg_capture_job_photos_updated_at
before update on public.capture_job_photos
for each row execute function public.set_updated_at();

create index if not exists idx_capture_job_photos_capture_job_sort_order
on public.capture_job_photos (capture_job_id, sort_order);

create unique index if not exists idx_capture_job_photos_single_primary
on public.capture_job_photos (capture_job_id)
where is_primary = true;

grant select, insert, update, delete on table public.capture_job_photos to authenticated;

alter table public.capture_job_photos enable row level security;
alter table public.capture_job_photos replica identity full;

drop policy if exists "capture_job_photos_read_active_employees" on public.capture_job_photos;
create policy "capture_job_photos_read_active_employees"
on public.capture_job_photos
for select
to authenticated
using (public.is_active_employee());

drop policy if exists "capture_job_photos_write_admin_manager" on public.capture_job_photos;
create policy "capture_job_photos_write_admin_manager"
on public.capture_job_photos
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

create or replace function public.record_capture_job_photo(
  _job_id uuid,
  _sort_order integer,
  _is_primary boolean,
  _storage_bucket text,
  _storage_path text,
  _file_size_bytes bigint,
  _image_width integer default null,
  _image_height integer default null,
  _mime_type text default 'image/jpeg',
  _label text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.capture_jobs%rowtype;
begin
  if not public.is_active_employee() then
    raise exception 'Active employee required' using errcode = '42501';
  end if;

  select j.*
  into v_job
  from public.capture_jobs j
  where j.id = _job_id
  for update;

  if not found then
    raise exception 'Capture job not found: %', _job_id using errcode = 'P0002';
  end if;

  if v_job.status <> 'uploading' then
    return false;
  end if;

  if coalesce(v_job.result_payload ->> 'handler_user_id', auth.uid()::text) <> auth.uid()::text then
    return false;
  end if;

  if split_part(_storage_path, '/'::text, 1) <> v_job.station_id::text
    or split_part(_storage_path, '/'::text, 2) <> v_job.id::text
    or split_part(_storage_path, '/'::text, 3) = '' then
    raise exception 'Storage path must match {station_id}/{job_id}/{file_name}' using errcode = '22023';
  end if;

  if _is_primary then
    update public.capture_job_photos
    set is_primary = false
    where capture_job_id = _job_id
      and sort_order <> _sort_order
      and is_primary = true;
  end if;

  insert into public.capture_job_photos (
    capture_job_id,
    sort_order,
    is_primary,
    storage_bucket,
    storage_path,
    file_size_bytes,
    image_width,
    image_height,
    mime_type,
    label
  )
  values (
    _job_id,
    _sort_order,
    _is_primary,
    _storage_bucket,
    _storage_path,
    _file_size_bytes,
    _image_width,
    _image_height,
    _mime_type,
    _label
  )
  on conflict (capture_job_id, sort_order)
  do update
  set
    is_primary = excluded.is_primary,
    storage_bucket = excluded.storage_bucket,
    storage_path = excluded.storage_path,
    file_size_bytes = excluded.file_size_bytes,
    image_width = excluded.image_width,
    image_height = excluded.image_height,
    mime_type = excluded.mime_type,
    label = excluded.label,
    updated_at = now();

  return true;
end;
$$;

grant execute on function public.record_capture_job_photo(
  uuid,
  integer,
  boolean,
  text,
  text,
  bigint,
  integer,
  integer,
  text,
  text
) to authenticated;

create or replace function public.complete_capture_job_multi_photo(
  _job_id uuid,
  _expected_photo_count integer,
  _upload_completed_at timestamptz default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.capture_jobs%rowtype;
  v_primary_photo public.capture_job_photos%rowtype;
  v_photo_count integer;
  v_primary_count integer;
  v_updated integer := 0;
begin
  if not public.is_active_employee() then
    raise exception 'Active employee required' using errcode = '42501';
  end if;

  if _expected_photo_count < 1 then
    raise exception 'At least one uploaded photo is required to complete a multi-photo capture job' using errcode = '22023';
  end if;

  select j.*
  into v_job
  from public.capture_jobs j
  where j.id = _job_id
  for update;

  if not found then
    raise exception 'Capture job not found: %', _job_id using errcode = 'P0002';
  end if;

  if v_job.status <> 'uploading' then
    return false;
  end if;

  if coalesce(v_job.result_payload ->> 'handler_user_id', auth.uid()::text) <> auth.uid()::text then
    return false;
  end if;

  select
    count(*)::integer,
    count(*) filter (where p.is_primary)::integer
  into
    v_photo_count,
    v_primary_count
  from public.capture_job_photos p
  where p.capture_job_id = _job_id;

  if v_photo_count <> _expected_photo_count then
    return false;
  end if;

  if v_primary_count <> 1 then
    return false;
  end if;

  select p.*
  into v_primary_photo
  from public.capture_job_photos p
  where p.capture_job_id = _job_id
    and p.is_primary = true
  limit 1;

  if not found then
    return false;
  end if;

  update public.capture_jobs j
  set
    status = 'completed',
    storage_bucket = v_primary_photo.storage_bucket,
    storage_path = v_primary_photo.storage_path,
    file_size_bytes = v_primary_photo.file_size_bytes,
    mime_type = v_primary_photo.mime_type,
    upload_completed_at = coalesce(_upload_completed_at, now()),
    failure_code = null,
    failure_message = null
  where j.id = _job_id
    and j.status = 'uploading'
    and coalesce(j.result_payload ->> 'handler_user_id', auth.uid()::text) = auth.uid()::text;

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

grant execute on function public.complete_capture_job_multi_photo(
  uuid,
  integer,
  timestamptz
) to authenticated;
