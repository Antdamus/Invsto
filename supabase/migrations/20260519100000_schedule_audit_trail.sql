-- Immutable audit trail for admin schedule changes.
-- Captures recurring schedules and one-off overrides, including deletes.

create table if not exists public.schedule_audit_log (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_email text,
  action text not null check (action in ('insert', 'update', 'delete')),
  schedule_table text not null check (schedule_table in ('work_schedules', 'work_schedule_overrides')),
  schedule_id uuid,
  employee_id uuid references public.employees(id) on delete set null,
  employee_name text,
  employee_email text,
  store_id uuid references public.store_locations(id) on delete set null,
  store_name text,
  work_date date,
  weekday smallint,
  effective_from date,
  effective_to date,
  start_local time,
  end_local time,
  off boolean,
  schedule_note text,
  changed_fields jsonb not null default '{}'::jsonb,
  old_data jsonb,
  new_data jsonb,
  request_metadata jsonb not null default '{}'::jsonb
);

alter table public.schedule_audit_log enable row level security;

drop policy if exists "schedule_audit_log_admin_select" on public.schedule_audit_log;
create policy "schedule_audit_log_admin_select"
on public.schedule_audit_log
for select
to authenticated
using (public.is_admin());

grant select on table public.schedule_audit_log to authenticated;
grant select, insert on table public.schedule_audit_log to service_role;

create index if not exists schedule_audit_log_occurred_at_idx
  on public.schedule_audit_log(occurred_at desc);

create index if not exists schedule_audit_log_actor_idx
  on public.schedule_audit_log(actor_user_id, occurred_at desc);

create index if not exists schedule_audit_log_employee_idx
  on public.schedule_audit_log(employee_id, occurred_at desc);

create index if not exists schedule_audit_log_store_idx
  on public.schedule_audit_log(store_id, occurred_at desc);

create index if not exists schedule_audit_log_schedule_record_idx
  on public.schedule_audit_log(schedule_table, schedule_id, occurred_at desc);

create index if not exists schedule_audit_log_work_date_idx
  on public.schedule_audit_log(work_date, occurred_at desc)
  where work_date is not null;

create or replace function public.schedule_audit_safe_json_setting(setting_name text)
returns jsonb
language plpgsql
stable
as $$
declare
  v_raw text;
begin
  v_raw := nullif(current_setting(setting_name, true), '');
  if v_raw is null then
    return '{}'::jsonb;
  end if;

  return v_raw::jsonb;
exception when others then
  return '{}'::jsonb;
end;
$$;

create or replace function public.schedule_audit_changed_fields(old_row jsonb, new_row jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_old jsonb := coalesce(old_row, '{}'::jsonb);
  v_new jsonb := coalesce(new_row, '{}'::jsonb);
  v_result jsonb := '{}'::jsonb;
  v_key text;
begin
  for v_key in
    select key
    from jsonb_object_keys(
      (v_old - array['created_at']::text[])
      || (v_new - array['created_at']::text[])
    ) as key
  loop
    if (v_old -> v_key) is distinct from (v_new -> v_key) then
      v_result := jsonb_set(
        v_result,
        array[v_key],
        jsonb_build_object('from', v_old -> v_key, 'to', v_new -> v_key),
        true
      );
    end if;
  end loop;

  return v_result;
end;
$$;

create or replace function public.schedule_audit_request_metadata()
returns jsonb
language plpgsql
stable
as $$
declare
  v_claims jsonb := public.schedule_audit_safe_json_setting('request.jwt.claims');
  v_headers jsonb := public.schedule_audit_safe_json_setting('request.headers');
begin
  return jsonb_strip_nulls(jsonb_build_object(
    'claims',
      jsonb_strip_nulls(jsonb_build_object(
        'sub', v_claims ->> 'sub',
        'email', v_claims ->> 'email',
        'role', v_claims ->> 'role'
      )),
    'headers',
      jsonb_strip_nulls(jsonb_build_object(
        'user_agent', v_headers ->> 'user-agent',
        'x_forwarded_for', v_headers ->> 'x-forwarded-for',
        'cf_connecting_ip', v_headers ->> 'cf-connecting-ip',
        'x_real_ip', v_headers ->> 'x-real-ip'
      ))
  ));
end;
$$;

create or replace function public.schedule_audit_actor_email(actor_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_email text;
  v_claims jsonb := public.schedule_audit_safe_json_setting('request.jwt.claims');
begin
  v_email := nullif(v_claims ->> 'email', '');

  if v_email is null and actor_id is not null then
    select u.email
      into v_email
    from auth.users u
    where u.id = actor_id
    limit 1;
  end if;

  if v_email is null and actor_id is not null then
    select e.email
      into v_email
    from public.employees e
    where e.user_id = actor_id
    limit 1;
  end if;

  return v_email;
end;
$$;

create or replace function public.log_work_schedule_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else '{}'::jsonb end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else '{}'::jsonb end;
  v_changed_fields jsonb := '{}'::jsonb;
  v_row jsonb;
  v_actor uuid := auth.uid();
  v_actor_email text;
  v_employee_id uuid;
  v_employee_name text;
  v_employee_email text;
  v_store_id uuid;
  v_store_name text;
begin
  v_changed_fields := public.schedule_audit_changed_fields(v_old, v_new);

  if tg_op = 'UPDATE' and v_changed_fields = '{}'::jsonb then
    return new;
  end if;

  v_row := case when tg_op = 'DELETE' then v_old else v_new end;
  v_employee_id := nullif(v_row ->> 'employee_id', '')::uuid;
  v_store_id := nullif(v_row ->> 'store_id', '')::uuid;
  v_actor_email := public.schedule_audit_actor_email(v_actor);

  if v_employee_id is not null then
    select e.display_name, e.email
      into v_employee_name, v_employee_email
    from public.employees e
    where e.id = v_employee_id
    limit 1;
  end if;

  if v_store_id is not null then
    select s.name
      into v_store_name
    from public.store_locations s
    where s.id = v_store_id
    limit 1;
  end if;

  insert into public.schedule_audit_log (
    actor_user_id,
    actor_email,
    action,
    schedule_table,
    schedule_id,
    employee_id,
    employee_name,
    employee_email,
    store_id,
    store_name,
    work_date,
    weekday,
    effective_from,
    effective_to,
    start_local,
    end_local,
    off,
    schedule_note,
    changed_fields,
    old_data,
    new_data,
    request_metadata
  )
  values (
    v_actor,
    v_actor_email,
    lower(tg_op),
    tg_table_name,
    nullif(v_row ->> 'id', '')::uuid,
    v_employee_id,
    v_employee_name,
    v_employee_email,
    v_store_id,
    v_store_name,
    nullif(v_row ->> 'work_date', '')::date,
    nullif(v_row ->> 'weekday', '')::smallint,
    nullif(v_row ->> 'effective_from', '')::date,
    nullif(v_row ->> 'effective_to', '')::date,
    nullif(v_row ->> 'start_local', '')::time,
    nullif(v_row ->> 'end_local', '')::time,
    nullif(v_row ->> 'off', '')::boolean,
    nullif(v_row ->> 'note', ''),
    v_changed_fields,
    nullif(v_old, '{}'::jsonb),
    nullif(v_new, '{}'::jsonb),
    public.schedule_audit_request_metadata()
  );

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

create or replace function public.prevent_schedule_audit_log_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'schedule_audit_log is immutable';
end;
$$;

drop trigger if exists trg_schedule_audit_log_immutable on public.schedule_audit_log;
create trigger trg_schedule_audit_log_immutable
before update or delete on public.schedule_audit_log
for each row
execute function public.prevent_schedule_audit_log_mutation();

drop trigger if exists trg_work_schedules_audit_log on public.work_schedules;
create trigger trg_work_schedules_audit_log
after insert or update or delete on public.work_schedules
for each row
execute function public.log_work_schedule_change();

drop trigger if exists trg_work_schedule_overrides_audit_log on public.work_schedule_overrides;
create trigger trg_work_schedule_overrides_audit_log
after insert or update or delete on public.work_schedule_overrides
for each row
execute function public.log_work_schedule_change();
