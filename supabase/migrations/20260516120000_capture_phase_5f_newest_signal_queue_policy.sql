create or replace function public.claim_newest_capture_job_for_station(
  _station_id uuid
)
returns table (
  job_id uuid,
  station_id uuid,
  status text,
  requested_at timestamptz,
  target_switched boolean,
  original_active_job_id uuid,
  superseded_count integer,
  message text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee_id uuid;
  v_user_id uuid := auth.uid();
  v_now timestamptz := now();
  v_target public.capture_jobs%rowtype;
  v_superseded_count integer := 0;
begin
  select e.id
  into v_employee_id
  from public.employees e
  where e.user_id = v_user_id
    and e.active = true;

  if v_employee_id is null then
    raise exception 'Active employee required' using errcode = '42501';
  end if;

  perform 1
  from public.capture_stations s
  where s.id = _station_id
    and s.active = true
  for update;

  if not found then
    raise exception 'Active capture station not found: %', _station_id using errcode = 'P0002';
  end if;

  perform 1
  from public.capture_jobs j
  where j.station_id = _station_id
    and j.status in ('queued', 'assigned')
  order by j.requested_at desc, j.created_at desc, j.id desc
  for update;

  select j.*
  into v_target
  from public.capture_jobs j
  where j.station_id = _station_id
    and j.status in ('queued', 'assigned')
  order by j.requested_at desc, j.created_at desc, j.id desc
  limit 1;

  if not found then
    raise exception 'No queued or assigned capture job found for station: %', _station_id using errcode = 'P0002';
  end if;

  update public.capture_jobs j
  set
    status = 'failed',
    failure_code = 'superseded_by_newer_request',
    failure_message = 'Superseded by newer capture request for this station.',
    result_payload = coalesce(j.result_payload, '{}'::jsonb) || jsonb_build_object(
      'superseded_by_job_id', v_target.id::text,
      'superseded_at', v_now,
      'superseded_reason', 'newest_signal_before_capture',
      'handler_employee_id', v_employee_id::text,
      'handler_user_id', v_user_id::text,
      'capture_client', 'iphone_app'
    )
  where j.station_id = _station_id
    and j.status in ('queued', 'assigned')
    and j.id <> v_target.id;

  get diagnostics v_superseded_count = row_count;

  update public.capture_jobs j
  set
    status = 'capturing',
    claimed_at = coalesce(j.claimed_at, v_now),
    capture_started_at = coalesce(j.capture_started_at, v_now),
    failure_code = null,
    failure_message = null,
    result_payload = coalesce(j.result_payload, '{}'::jsonb) || jsonb_build_object(
      'handler_employee_id', v_employee_id::text,
      'handler_user_id', v_user_id::text,
      'capture_client', 'iphone_app',
      'claimed_by_rpc', 'claim_newest_capture_job_for_station',
      'claimed_at', v_now
    )
  where j.id = v_target.id
    and j.status in ('queued', 'assigned')
  returning j.*
  into v_target;

  if not found then
    raise exception 'Newest capture job could not be claimed: %', v_target.id using errcode = '40001';
  end if;

  return query
  select
    v_target.id,
    v_target.station_id,
    v_target.status,
    v_target.requested_at,
    false,
    null::uuid,
    v_superseded_count,
    case
      when v_superseded_count = 0 then 'Claimed newest pending capture job.'
      else 'Claimed newest pending capture job and superseded older pending jobs.'
    end;
end;
$$;

grant execute on function public.claim_newest_capture_job_for_station(uuid) to authenticated;

comment on function public.claim_newest_capture_job_for_station(uuid)
is 'Atomically claims the newest queued/assigned capture job for a station and marks older pending duplicates as superseded.';

create or replace function public.resolve_final_capture_upload_target(
  _station_id uuid,
  _current_active_job_id uuid
)
returns table (
  job_id uuid,
  station_id uuid,
  status text,
  requested_at timestamptz,
  target_switched boolean,
  original_active_job_id uuid,
  superseded_count integer,
  message text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee_id uuid;
  v_user_id uuid := auth.uid();
  v_now timestamptz := now();
  v_current public.capture_jobs%rowtype;
  v_newest_pending public.capture_jobs%rowtype;
  v_final_target public.capture_jobs%rowtype;
  v_pending_superseded_count integer := 0;
  v_superseded_count integer := 0;
  v_has_newer_pending boolean := false;
begin
  select e.id
  into v_employee_id
  from public.employees e
  where e.user_id = v_user_id
    and e.active = true;

  if v_employee_id is null then
    raise exception 'Active employee required' using errcode = '42501';
  end if;

  perform 1
  from public.capture_stations s
  where s.id = _station_id
    and s.active = true
  for update;

  if not found then
    raise exception 'Active capture station not found: %', _station_id using errcode = 'P0002';
  end if;

  select j.*
  into v_current
  from public.capture_jobs j
  where j.id = _current_active_job_id
  for update;

  if not found then
    raise exception 'Current active capture job not found: %', _current_active_job_id using errcode = 'P0002';
  end if;

  if v_current.station_id <> _station_id then
    raise exception 'Current active capture job does not belong to station: %', _station_id using errcode = '22023';
  end if;

  if v_current.status <> 'capturing' then
    raise exception 'Current active capture job must be capturing; found %', v_current.status using errcode = '22023';
  end if;

  if (v_current.result_payload ->> 'handler_user_id') is distinct from v_user_id::text then
    raise exception 'Current active capture job is not handled by the current user' using errcode = '42501';
  end if;

  perform 1
  from public.capture_jobs j
  where j.station_id = _station_id
    and j.status in ('queued', 'assigned')
  order by j.requested_at desc, j.created_at desc, j.id desc
  for update;

  select j.*
  into v_newest_pending
  from public.capture_jobs j
  where j.station_id = _station_id
    and j.status in ('queued', 'assigned')
  order by j.requested_at desc, j.created_at desc, j.id desc
  limit 1;

  if found then
    v_has_newer_pending :=
      (v_newest_pending.requested_at, v_newest_pending.created_at, v_newest_pending.id::text)
      >
      (v_current.requested_at, v_current.created_at, v_current.id::text);
  end if;

  if v_has_newer_pending then
    update public.capture_jobs j
    set
      status = 'failed',
      failure_code = 'superseded_by_newer_request_at_finish',
      failure_message = 'Superseded at Finish Job by newer capture request for this station.',
      result_payload = coalesce(j.result_payload, '{}'::jsonb) || jsonb_build_object(
        'superseded_by_job_id', v_newest_pending.id::text,
        'superseded_at', v_now,
        'superseded_reason', 'newest_signal_at_finish',
        'original_active_job_id', v_current.id::text,
        'handler_employee_id', v_employee_id::text,
        'handler_user_id', v_user_id::text,
        'capture_client', 'iphone_app'
      )
    where j.id = v_current.id
      and j.status = 'capturing';

    get diagnostics v_superseded_count = row_count;

    update public.capture_jobs j
    set
      status = 'failed',
      failure_code = 'superseded_by_newer_request',
      failure_message = 'Superseded by newer capture request for this station.',
      result_payload = coalesce(j.result_payload, '{}'::jsonb) || jsonb_build_object(
        'superseded_by_job_id', v_newest_pending.id::text,
        'superseded_at', v_now,
        'superseded_reason', 'newest_signal_at_finish',
        'original_active_job_id', v_current.id::text,
        'handler_employee_id', v_employee_id::text,
        'handler_user_id', v_user_id::text,
        'capture_client', 'iphone_app'
      )
    where j.station_id = _station_id
      and j.status in ('queued', 'assigned')
      and j.id <> v_newest_pending.id;

    get diagnostics v_pending_superseded_count = row_count;
    v_superseded_count := v_superseded_count + v_pending_superseded_count;

    update public.capture_jobs j
    set
      status = 'uploading',
      claimed_at = coalesce(j.claimed_at, v_now),
      capture_started_at = coalesce(j.capture_started_at, v_now),
      capture_completed_at = coalesce(j.capture_completed_at, v_now),
      failure_code = null,
      failure_message = null,
      result_payload = coalesce(j.result_payload, '{}'::jsonb) || jsonb_build_object(
        'handler_employee_id', v_employee_id::text,
        'handler_user_id', v_user_id::text,
        'capture_client', 'iphone_app',
        'upload_target_resolved_by_rpc', 'resolve_final_capture_upload_target',
        'upload_target_resolved_at', v_now,
        'original_active_job_id', v_current.id::text,
        'target_switched', true
      )
    where j.id = v_newest_pending.id
      and j.status in ('queued', 'assigned')
    returning j.*
    into v_final_target;

    if not found then
      raise exception 'Newest pending capture job could not be moved to uploading: %', v_newest_pending.id using errcode = '40001';
    end if;

    return query
    select
      v_final_target.id,
      v_final_target.station_id,
      v_final_target.status,
      v_final_target.requested_at,
      true,
      v_current.id,
      v_superseded_count,
      'Resolved newer pending capture job as final upload target.';

    return;
  end if;

  update public.capture_jobs j
  set
    status = 'failed',
    failure_code = 'superseded_by_newer_request',
    failure_message = 'Superseded by newer capture request for this station.',
    result_payload = coalesce(j.result_payload, '{}'::jsonb) || jsonb_build_object(
      'superseded_by_job_id', v_current.id::text,
      'superseded_at', v_now,
      'superseded_reason', 'current_active_job_remained_final_target',
      'original_active_job_id', v_current.id::text,
      'handler_employee_id', v_employee_id::text,
      'handler_user_id', v_user_id::text,
      'capture_client', 'iphone_app'
    )
  where j.station_id = _station_id
    and j.status in ('queued', 'assigned');

  get diagnostics v_superseded_count = row_count;

  update public.capture_jobs j
  set
    status = 'uploading',
    capture_completed_at = coalesce(j.capture_completed_at, v_now),
    failure_code = null,
    failure_message = null,
    result_payload = coalesce(j.result_payload, '{}'::jsonb) || jsonb_build_object(
      'upload_target_resolved_by_rpc', 'resolve_final_capture_upload_target',
      'upload_target_resolved_at', v_now,
      'original_active_job_id', v_current.id::text,
      'target_switched', false,
      'capture_client', 'iphone_app'
    )
  where j.id = v_current.id
    and j.status = 'capturing'
    and (j.result_payload ->> 'handler_user_id') = v_user_id::text
  returning j.*
  into v_final_target;

  if not found then
    raise exception 'Current active capture job could not be moved to uploading: %', v_current.id using errcode = '40001';
  end if;

  return query
  select
    v_final_target.id,
    v_final_target.station_id,
    v_final_target.status,
    v_final_target.requested_at,
    false,
    v_current.id,
    v_superseded_count,
    case
      when v_superseded_count = 0 then 'Resolved current active capture job as final upload target.'
      else 'Resolved current active capture job as final upload target and superseded older pending jobs.'
    end;
end;
$$;

grant execute on function public.resolve_final_capture_upload_target(uuid, uuid) to authenticated;

comment on function public.resolve_final_capture_upload_target(uuid, uuid)
is 'Atomically resolves the final upload target at Finish Job, optionally switching to the newest pending station job and superseding duplicates.';
