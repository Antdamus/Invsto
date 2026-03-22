insert into storage.buckets (
  id,
  name,
  public
)
select
  'capture-photos',
  'capture-photos',
  false
where not exists (
  select 1
  from storage.buckets
  where id = 'capture-photos'
);

drop policy if exists "capture_photos_employee_insert" on storage.objects;
create policy "capture_photos_employee_insert"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'capture-photos'
  and exists (
    select 1
    from public.employees e
    join public.capture_jobs j
      on j.station_id::text = split_part(objects.name, '/'::text, 1)
     and j.id::text = split_part(objects.name, '/'::text, 2)
    join public.capture_stations s
      on s.id = j.station_id
    where e.user_id = auth.uid()
      and e.active = true
      and s.active = true
      and split_part(objects.name, '/'::text, 3) <> ''
  )
);

drop policy if exists "capture_photos_employee_read" on storage.objects;
create policy "capture_photos_employee_read"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'capture-photos'
  and exists (
    select 1
    from public.employees e
    join public.capture_jobs j
      on j.station_id::text = split_part(objects.name, '/'::text, 1)
     and j.id::text = split_part(objects.name, '/'::text, 2)
    join public.capture_stations s
      on s.id = j.station_id
    where e.user_id = auth.uid()
      and e.active = true
      and s.active = true
      and split_part(objects.name, '/'::text, 3) <> ''
  )
);

create or replace function public.update_capture_job_lifecycle(
  _job_id uuid,
  _target_status text,
  _failure_code text default null,
  _failure_message text default null,
  _storage_bucket text default null,
  _storage_path text default null,
  _file_size_bytes bigint default null,
  _mime_type text default null,
  _capture_completed_at timestamptz default null,
  _upload_completed_at timestamptz default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee_id uuid;
  v_updated integer := 0;
begin
  select e.id
  into v_employee_id
  from public.employees e
  where e.user_id = auth.uid()
    and e.active = true;

  if v_employee_id is null then
    raise exception 'Active employee required' using errcode = '42501';
  end if;

  if _target_status not in ('capturing', 'uploading', 'completed', 'failed') then
    raise exception 'Unsupported capture lifecycle state: %', _target_status using errcode = '22023';
  end if;

  if _target_status = 'completed' and (_storage_bucket is null or _storage_path is null) then
    raise exception 'Completed capture jobs require storage metadata' using errcode = '22023';
  end if;

  if _target_status = 'failed' and (_failure_code is null or _failure_message is null) then
    raise exception 'Failed capture jobs require failure details' using errcode = '22023';
  end if;

  if _target_status = 'capturing' then
    update public.capture_jobs j
    set
      status = 'capturing',
      claimed_at = coalesce(j.claimed_at, now()),
      capture_started_at = coalesce(j.capture_started_at, now()),
      failure_code = null,
      failure_message = null,
      result_payload = coalesce(j.result_payload, '{}'::jsonb) || jsonb_build_object(
        'handler_employee_id', v_employee_id::text,
        'handler_user_id', auth.uid()::text,
        'capture_client', 'iphone_app'
      )
    where j.id = _job_id
      and j.status in ('queued', 'assigned');
    get diagnostics v_updated = row_count;
    return v_updated = 1;
  end if;

  if _target_status = 'uploading' then
    update public.capture_jobs j
    set
      status = 'uploading',
      capture_completed_at = coalesce(_capture_completed_at, now()),
      failure_code = null,
      failure_message = null
    where j.id = _job_id
      and j.status = 'capturing'
      and coalesce(j.result_payload ->> 'handler_user_id', auth.uid()::text) = auth.uid()::text;
    get diagnostics v_updated = row_count;
    return v_updated = 1;
  end if;

  if _target_status = 'completed' then
    update public.capture_jobs j
    set
      status = 'completed',
      storage_bucket = _storage_bucket,
      storage_path = _storage_path,
      file_size_bytes = _file_size_bytes,
      mime_type = _mime_type,
      upload_completed_at = coalesce(_upload_completed_at, now()),
      failure_code = null,
      failure_message = null
    where j.id = _job_id
      and j.status = 'uploading'
      and coalesce(j.result_payload ->> 'handler_user_id', auth.uid()::text) = auth.uid()::text;
    get diagnostics v_updated = row_count;
    return v_updated = 1;
  end if;

  update public.capture_jobs j
  set
    status = 'failed',
    failure_code = _failure_code,
    failure_message = _failure_message
  where j.id = _job_id
    and j.status in ('capturing', 'uploading')
    and coalesce(j.result_payload ->> 'handler_user_id', auth.uid()::text) = auth.uid()::text;
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

grant execute on function public.update_capture_job_lifecycle(
  uuid,
  text,
  text,
  text,
  text,
  text,
  bigint,
  text,
  timestamptz,
  timestamptz
) to authenticated;

