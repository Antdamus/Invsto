-- ============================================================
-- Work Schedule Override DELETE → SMS "cancelled" enqueue
-- ============================================================

create or replace function public.enqueue_work_schedule_override_cancelled_sms()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_phone text;
  v_employee_name text;
  v_store_name text;
  v_body text;
begin
  -- Resolve auth user + display name
  select e.user_id, e.display_name
  into v_user_id, v_employee_name
  from public.employees e
  where e.id = old.employee_id
  limit 1;

  if v_user_id is null then
    return old;
  end if;

  -- Resolve SMS-capable phone
  select up.phone_e164
  into v_phone
  from public.user_phones up
  where up.user_id = v_user_id
    and up.can_sms = true
  limit 1;

  if v_phone is null then
    return old;
  end if;

  -- Resolve store name (optional)
  if old.store_id is not null then
    select s.name
    into v_store_name
    from public.store_locations s
    where s.id = old.store_id
    limit 1;
  end if;

  -- Build cancellation message
  v_body :=
    'OG Jewelers schedule update' || E'\n' ||
    'Hi ' || v_employee_name || ', your assigned shift was cancelled.' || E'\n' ||
    E'\n' ||
    'Date: ' || to_char(old.work_date, 'Dy Mon DD, YYYY');

  if old.off = false then
    v_body := v_body || E'\n' ||
      'Time: ' ||
      coalesce(to_char(old.start_local, 'HH12:MI AM'), 'TBD') ||
      ' – ' ||
      coalesce(to_char(old.end_local, 'HH12:MI AM'), 'TBD');
  end if;

  if v_store_name is not null then
    v_body := v_body || E'\n' || 'Location: ' || v_store_name;
  end if;

  -- Enqueue SMS
  insert into public.sms_outbox (
    to_phone,
    body,
    status,
    meta
  )
  values (
    v_phone,
    v_body,
    'pending',
    jsonb_build_object(
      'type', 'work_schedule_override_cancelled',
      'override_id', old.id,
      'employee_id', old.employee_id,
      'work_date', old.work_date
    )
  );

  return old;
end;
$$;
drop trigger if exists trg_wso_sms_cancelled on public.work_schedule_overrides;
create trigger trg_wso_sms_cancelled
after delete on public.work_schedule_overrides
for each row
execute function public.enqueue_work_schedule_override_cancelled_sms();
create unique index if not exists sms_outbox_unique_work_override_cancelled
on public.sms_outbox ((meta->>'type'), (meta->>'override_id'))
where meta->>'type' = 'work_schedule_override_cancelled';
