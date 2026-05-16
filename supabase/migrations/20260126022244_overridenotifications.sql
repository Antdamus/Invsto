-- ============================================================
-- Work Schedule Override → SMS Notification Enqueue
-- OG Jewelers
-- ============================================================

create or replace function public.enqueue_work_schedule_override_sms()
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
  v_tz text;
  v_body text;
begin
  -- Resolve auth user + display name
  select e.user_id, e.display_name
  into v_user_id, v_employee_name
  from public.employees e
  where e.id = new.employee_id
  limit 1;

  if v_user_id is null then
    return new;
  end if;

  -- Resolve SMS-capable phone
  select up.phone_e164
  into v_phone
  from public.user_phones up
  where up.user_id = v_user_id
    and up.can_sms = true
  limit 1;

  if v_phone is null then
    return new;
  end if;

  -- Resolve store name + timezone (optional but nice)
  if new.store_id is not null then
    select s.name, s.timezone
    into v_store_name, v_tz
    from public.store_locations s
    where s.id = new.store_id
    limit 1;
  end if;

  -- Build SMS body
  if new.off = true then
    v_body :=
      'OG Jewelers schedule update' || E'\n' ||
      'You are marked OFF on ' ||
      to_char(new.work_date, 'Dy Mon DD, YYYY') || '.';
  else
    v_body :=
      'OG Jewelers schedule update' || E'\n' ||
      'Hi ' || v_employee_name || ', you were assigned a shift.' || E'\n' ||
      E'\n' ||
      'Date: ' || to_char(new.work_date, 'Dy Mon DD, YYYY') || E'\n' ||
      'Time: ' ||
        coalesce(to_char(new.start_local, 'HH12:MI AM'), 'TBD') ||
        ' – ' ||
        coalesce(to_char(new.end_local, 'HH12:MI AM'), 'TBD');

    if v_store_name is not null then
      v_body := v_body || E'\n' || 'Location: ' || v_store_name;
    end if;

    if new.note is not null and length(trim(new.note)) > 0 then
      v_body := v_body || E'\n' || 'Notes: ' || new.note;
    end if;
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
      'type', 'work_schedule_override_created',
      'override_id', new.id,
      'employee_id', new.employee_id,
      'work_date', new.work_date
    )
  );

  return new;
end;
$$;
-- Attach trigger
drop trigger if exists trg_wso_sms on public.work_schedule_overrides;
create trigger trg_wso_sms
after insert on public.work_schedule_overrides
for each row
execute function public.enqueue_work_schedule_override_sms();
-- Prevent duplicate SMS for same override
create unique index if not exists sms_outbox_unique_work_override
on public.sms_outbox (
  (meta->>'type'),
  (meta->>'override_id')
)
where meta->>'type' = 'work_schedule_override_created';
