-- Payroll readiness repairs.
-- Fixes payment recording, readiness checks, finalization, statements, rounding,
-- seller exclusion from hourly payroll, and richer immutable payroll snapshots.

drop index if exists public.contractor_payments_unique_active;

alter table public.payroll_run_lines
  add column if not exists regular_seconds bigint not null default 0,
  add column if not exists overtime_seconds bigint not null default 0,
  add column if not exists regular_pay numeric not null default 0,
  add column if not exists overtime_pay numeric not null default 0;

alter table public.payroll_runs
  add column if not exists built_at timestamptz,
  add column if not exists built_by uuid references auth.users(id);

alter table public.contractor_payments
  add column if not exists voided_at timestamptz,
  add column if not exists voided_by uuid references auth.users(id),
  add column if not exists void_reason text;

alter table public.contractor_payments
  alter column method set default 'other';

alter table public.payroll_runs
  drop constraint if exists payroll_runs_rounding_mode_check;

alter table public.payroll_runs
  add constraint payroll_runs_rounding_mode_check
  check (rounding_mode = any (array['none','nearest_minute','nearest_5','nearest_10','nearest_15']));

create table if not exists public.payroll_payment_audits (
  id uuid primary key default gen_random_uuid(),
  contractor_payment_id uuid references public.contractor_payments(id) on delete set null,
  payroll_run_id uuid references public.payroll_runs(id) on delete set null,
  employee_id uuid references public.employees(id) on delete set null,
  action text not null check (action in ('record_payment', 'void_payment')),
  actor_user_id uuid not null default auth.uid(),
  reason text,
  old_value jsonb not null default '{}'::jsonb,
  new_value jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.payroll_payment_audits enable row level security;

drop policy if exists "payroll_payment_audits_admin_select" on public.payroll_payment_audits;
create policy "payroll_payment_audits_admin_select"
  on public.payroll_payment_audits
  for select
  to authenticated
  using (public.is_admin());

grant select on public.payroll_payment_audits to authenticated;
grant select, insert, update, delete on public.payroll_payment_audits to service_role;

create index if not exists payroll_payment_audits_payment_idx
  on public.payroll_payment_audits (contractor_payment_id, created_at desc);

create index if not exists payroll_payment_audits_run_employee_idx
  on public.payroll_payment_audits (payroll_run_id, employee_id, created_at desc);

create or replace function public.round_seconds(_seconds bigint, _mode text)
returns bigint
language plpgsql
immutable
as $function$
declare
  v_step int;
  v_s bigint := greatest(coalesce(_seconds, 0), 0);
begin
  if _mode is null or _mode = '' or _mode = 'none' then
    return v_s;
  end if;

  if _mode = 'nearest_minute' then
    v_step := 60;
  elsif _mode = 'nearest_5' then
    v_step := 5 * 60;
  elsif _mode = 'nearest_10' then
    v_step := 10 * 60;
  elsif _mode = 'nearest_15' then
    v_step := 15 * 60;
  else
    raise exception 'Invalid rounding_mode: %', _mode using errcode = '22023';
  end if;

  return ((v_s + (v_step / 2)) / v_step) * v_step;
end;
$function$;

create or replace function public.create_payroll_run(
  _pay_period_id uuid,
  _rounding_mode text default 'nearest_15',
  _note text default null
)
returns public.payroll_runs
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_p public.pay_periods;
  v_run public.payroll_runs;
begin
  if not public.is_admin() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  select * into v_p
  from public.pay_periods
  where id = _pay_period_id;

  if v_p.id is null then
    raise exception 'Pay period not found' using errcode = '22023';
  end if;

  if _rounding_mode not in ('nearest_15', 'nearest_10', 'nearest_5', 'nearest_minute', 'none') then
    raise exception 'Invalid rounding_mode' using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.payroll_runs pr
    where pr.pay_period_id = _pay_period_id
      and pr.status = 'final'
  ) then
    raise exception 'Cannot create a draft run after this period has a final payroll run'
      using errcode = '22023';
  end if;

  insert into public.payroll_runs (
    pay_period_id, status, rounding_mode, break_policy, rules, note, created_by
  ) values (
    _pay_period_id,
    'draft',
    _rounding_mode,
    'paid_cap_per_day',
    jsonb_build_object(
      'break_cap_source', 'store_locations.paid_break_cap_min',
      'paid_break_cap_default_min', 30,
      'overtime_rule', 'weekly_after_40_hours',
      'seller_role_excluded', true,
      'period_boundary_clipping', true
    ),
    _note,
    auth.uid()
  )
  returning * into v_run;

  return v_run;
end;
$function$;

create or replace function public.payroll_period_readiness(_period_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_p public.pay_periods;
  v_start timestamptz;
  v_end timestamptz;
  v_open_shifts int := 0;
  v_open_breaks int := 0;
  v_pending_approval int := 0;
  v_unwaived_anomalies int := 0;
  v_missing_rates int := 0;
  v_seller_excluded int := 0;
  v_draft_runs int := 0;
  v_final_runs int := 0;
begin
  if not public.is_admin() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  select * into v_p
  from public.pay_periods
  where id = _period_id;

  if v_p.id is null then
    raise exception 'Pay period not found' using errcode = '22023';
  end if;

  v_start := make_timestamptz(
    extract(year from v_p.start_date)::int,
    extract(month from v_p.start_date)::int,
    extract(day from v_p.start_date)::int,
    0, 0, 0, v_p.timezone
  );

  v_end := make_timestamptz(
    extract(year from (v_p.end_date + 1))::int,
    extract(month from (v_p.end_date + 1))::int,
    extract(day from (v_p.end_date + 1))::int,
    0, 0, 0, v_p.timezone
  );

  select count(*) into v_open_shifts
  from public.time_entries t
  join public.employees e on e.id = t.employee_id
  where t.clock_out is null
    and t.clock_in < v_end
    and lower(coalesce(e.role, '')) <> 'seller';

  select count(*) into v_open_breaks
  from public.time_breaks b
  join public.time_entries t on t.id = b.time_entry_id
  join public.employees e on e.id = t.employee_id
  where b.ended_at is null
    and t.clock_in < v_end
    and lower(coalesce(e.role, '')) <> 'seller';

  select count(*) into v_pending_approval
  from public.time_entries t
  join public.employees e on e.id = t.employee_id
  where t.clock_out is not null
    and t.clock_in < v_end
    and t.clock_out > v_start
    and lower(coalesce(e.role, '')) <> 'seller'
    and not exists (
      select 1
      from public.shift_approvals sa
      where sa.time_entry_id = t.id
    );

  select count(*) into v_unwaived_anomalies
  from public.v_shift_anomalies a
  join public.employees e on e.id = a.employee_id
  where a.clock_out is not null
    and a.clock_in < v_end
    and a.clock_out > v_start
    and lower(coalesce(e.role, '')) <> 'seller'
    and a.has_anomaly
    and coalesce(a.approval_status, '') <> 'waived';

  select count(distinct t.id) into v_missing_rates
  from public.time_entries t
  join public.employees e on e.id = t.employee_id
  join public.shift_approvals sa on sa.time_entry_id = t.id
  left join public.store_locations s on s.id = t.store_id
  cross join lateral generate_series(
    public.ts_local_date(greatest(t.clock_in, v_start), coalesce(s.timezone, v_p.timezone))::timestamp,
    public.ts_local_date(least(t.clock_out, v_end) - interval '1 microsecond', coalesce(s.timezone, v_p.timezone))::timestamp,
    interval '1 day'
  ) as g(local_day)
  where t.clock_out is not null
    and t.clock_in < v_end
    and t.clock_out > v_start
    and lower(coalesce(e.role, '')) <> 'seller'
    and public.resolve_hourly_rate(t.employee_id, g.local_day::date) is null;

  select count(*) into v_seller_excluded
  from public.time_entries t
  join public.employees e on e.id = t.employee_id
  where t.clock_in < v_end
    and coalesce(t.clock_out, v_end) > v_start
    and lower(coalesce(e.role, '')) = 'seller';

  select
    count(*) filter (where status = 'draft'),
    count(*) filter (where status = 'final')
  into v_draft_runs, v_final_runs
  from public.payroll_runs
  where pay_period_id = _period_id;

  return jsonb_build_object(
    'period_id', v_p.id,
    'period_status', v_p.status,
    'open_shifts', v_open_shifts,
    'open_breaks', v_open_breaks,
    'pending_approval', v_pending_approval,
    'unwaived_anomalies', v_unwaived_anomalies,
    'missing_rates', v_missing_rates,
    'seller_excluded', v_seller_excluded,
    'draft_runs', v_draft_runs,
    'final_runs', v_final_runs,
    'ready', (
      v_open_shifts = 0
      and v_open_breaks = 0
      and v_pending_approval = 0
      and v_unwaived_anomalies = 0
      and v_missing_rates = 0
    )
  );
end;
$function$;

create or replace function public.payroll_lock_period(
  _period_id uuid,
  _note text default null,
  _force boolean default false
)
returns public.pay_periods
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_p public.pay_periods;
  v_readiness jsonb;
begin
  if not public.is_admin() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  select * into v_p
  from public.pay_periods
  where id = _period_id
  for update;

  if v_p.id is null then
    raise exception 'Pay period not found' using errcode = '22023';
  end if;

  if v_p.status = 'locked' then
    return v_p;
  end if;

  v_readiness := public.payroll_period_readiness(_period_id);

  if not _force then
    if (v_readiness->>'open_shifts')::int > 0 then
      raise exception 'Cannot lock: % open hourly shift(s) overlap this period', (v_readiness->>'open_shifts')::int
        using errcode = '22023';
    end if;

    if (v_readiness->>'open_breaks')::int > 0 then
      raise exception 'Cannot lock: % open hourly break(s) overlap this period', (v_readiness->>'open_breaks')::int
        using errcode = '22023';
    end if;
  end if;

  if (v_readiness->>'pending_approval')::int > 0 then
    raise exception 'Cannot lock: % hourly shift(s) pending approval in this period', (v_readiness->>'pending_approval')::int
      using errcode = '22023';
  end if;

  if (v_readiness->>'unwaived_anomalies')::int > 0 then
    raise exception 'Cannot lock: % hourly shift(s) have anomalies not waived', (v_readiness->>'unwaived_anomalies')::int
      using errcode = '22023';
  end if;

  if (v_readiness->>'missing_rates')::int > 0 then
    raise exception 'Cannot lock: % hourly shift(s) are missing an hourly rate', (v_readiness->>'missing_rates')::int
      using errcode = '22023';
  end if;

  update public.pay_periods
  set status = 'locked',
      locked_at = now(),
      locked_by = auth.uid(),
      note = case
        when _note is null or trim(_note) = '' then note
        else coalesce(note, '') || case when note is null then '' else E'\n' end || _note
      end
  where id = v_p.id
  returning * into v_p;

  return v_p;
end;
$function$;

create or replace function public.payroll_unlock_period(_period_id uuid, _note text default null)
returns public.pay_periods
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_p public.pay_periods;
begin
  if not public.is_admin() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  if exists (
    select 1
    from public.payroll_runs r
    where r.pay_period_id = _period_id
      and r.status = 'final'
  ) then
    raise exception 'Cannot unlock: this period has a final payroll run. Void/correct payroll before unlocking.'
      using errcode = '22023';
  end if;

  update public.pay_periods
  set status = 'open',
      locked_at = null,
      locked_by = null,
      note = case
        when _note is null or trim(_note) = '' then note
        else coalesce(note, '') || case when note is null then '' else E'\n' end || _note
      end
  where id = _period_id
  returning * into v_p;

  if v_p.id is null then
    raise exception 'Pay period not found' using errcode = '22023';
  end if;

  return v_p;
end;
$function$;

create or replace function public.build_payroll_run_lines(_payroll_run_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_run public.payroll_runs;
  v_p public.pay_periods;
  v_rows int := 0;
  v_start timestamptz;
  v_end timestamptz;
  v_readiness jsonb;
  v_blockers text[];
begin
  if not public.is_admin() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  select * into v_run
  from public.payroll_runs
  where id = _payroll_run_id
  for update;

  if v_run.id is null then
    raise exception 'Payroll run not found' using errcode = '22023';
  end if;

  if v_run.status <> 'draft' then
    raise exception 'Can only build lines for a draft run' using errcode = '22023';
  end if;

  select * into v_p
  from public.pay_periods
  where id = v_run.pay_period_id;

  if v_p.id is null then
    raise exception 'Pay period missing for run' using errcode = '22023';
  end if;

  v_start := make_timestamptz(
    extract(year from v_p.start_date)::int,
    extract(month from v_p.start_date)::int,
    extract(day from v_p.start_date)::int,
    0, 0, 0, v_p.timezone
  );

  v_end := make_timestamptz(
    extract(year from (v_p.end_date + 1))::int,
    extract(month from (v_p.end_date + 1))::int,
    extract(day from (v_p.end_date + 1))::int,
    0, 0, 0, v_p.timezone
  );

  v_readiness := public.payroll_period_readiness(v_p.id);
  v_blockers := array_remove(array[
    case when (v_readiness->>'open_shifts')::int > 0 then (v_readiness->>'open_shifts') || ' open shift(s)' end,
    case when (v_readiness->>'open_breaks')::int > 0 then (v_readiness->>'open_breaks') || ' open break(s)' end,
    case when (v_readiness->>'pending_approval')::int > 0 then (v_readiness->>'pending_approval') || ' pending approval(s)' end,
    case when (v_readiness->>'unwaived_anomalies')::int > 0 then (v_readiness->>'unwaived_anomalies') || ' unwaived anomaly shift(s)' end,
    case when (v_readiness->>'missing_rates')::int > 0 then (v_readiness->>'missing_rates') || ' missing hourly rate shift(s)' end
  ], null);

  if array_length(v_blockers, 1) is not null then
    raise exception 'Cannot build payroll: %', array_to_string(v_blockers, ', ')
      using errcode = '22023';
  end if;

  delete from public.payroll_run_lines where payroll_run_id = v_run.id;

  with raw_shifts as (
    select
      t.id as time_entry_id,
      t.employee_id,
      t.store_id,
      coalesce(s.name, 'Unassigned store') as store_name,
      coalesce(s.timezone, v_p.timezone) as store_tz,
      coalesce(s.paid_break_cap_min, 30) as paid_break_cap_min,
      t.clock_in,
      t.clock_out,
      greatest(t.clock_in, v_start) as clipped_start,
      least(t.clock_out, v_end) as clipped_end,
      t.schedule_codes,
      t.schedule_note,
      t.expected_start_ts,
      t.expected_end_ts,
      t.device_info,
      t.note,
      t.photo_in_path,
      t.photo_out_path,
      t.geo_ok_in,
      t.geo_ok_out,
      t.clock_in_distance_m,
      t.clock_out_distance_m,
      sa.status as approval_status,
      sa.note as approval_note,
      sa.approved_by,
      sa.approved_at
    from public.time_entries t
    join public.employees e on e.id = t.employee_id
    join public.shift_approvals sa on sa.time_entry_id = t.id
    left join public.store_locations s on s.id = t.store_id
    where t.clock_out is not null
      and t.clock_in < v_end
      and t.clock_out > v_start
      and lower(coalesce(e.role, '')) <> 'seller'
  ),
  shift_segments as (
    select
      rs.*,
      g.local_day::date as work_date_local,
      greatest(rs.clipped_start, (g.local_day::timestamp at time zone rs.store_tz)) as seg_start,
      least(rs.clipped_end, ((g.local_day::timestamp + interval '1 day') at time zone rs.store_tz)) as seg_end
    from raw_shifts rs
    cross join lateral generate_series(
      public.ts_local_date(rs.clipped_start, rs.store_tz)::timestamp,
      public.ts_local_date(rs.clipped_end - interval '1 microsecond', rs.store_tz)::timestamp,
      interval '1 day'
    ) as g(local_day)
    where rs.clipped_end > rs.clipped_start
  ),
  valid_segments as (
    select *
    from shift_segments
    where seg_end > seg_start
  ),
  segment_breaks as (
    select
      ss.time_entry_id,
      ss.employee_id,
      ss.store_id,
      ss.work_date_local,
      coalesce(sum(
        greatest(
          0,
          extract(epoch from (least(b.ended_at, ss.seg_end) - greatest(b.started_at, ss.seg_start)))
        )
      ), 0)::bigint as break_seconds
    from valid_segments ss
    left join public.time_breaks b
      on b.time_entry_id = ss.time_entry_id
     and b.ended_at is not null
     and b.started_at < ss.seg_end
     and b.ended_at > ss.seg_start
    group by ss.time_entry_id, ss.employee_id, ss.store_id, ss.work_date_local
  ),
  store_day as (
    select
      ss.employee_id,
      ss.store_id,
      ss.store_name,
      ss.work_date_local,
      ss.paid_break_cap_min,
      sum(extract(epoch from (ss.seg_end - ss.seg_start)))::bigint as worked_seconds,
      sum(coalesce(sb.break_seconds, 0))::bigint as break_seconds,
      count(distinct ss.time_entry_id)::int as shift_segments_count,
      jsonb_agg(
        jsonb_build_object(
          'time_entry_id', ss.time_entry_id,
          'store_id', ss.store_id,
          'store_name', ss.store_name,
          'clock_in', ss.clock_in,
          'clock_out', ss.clock_out,
          'clipped_start', ss.clipped_start,
          'clipped_end', ss.clipped_end,
          'segment_start', ss.seg_start,
          'segment_end', ss.seg_end,
          'work_date', ss.work_date_local,
          'worked_hours', round((extract(epoch from (ss.seg_end - ss.seg_start)) / 3600.0)::numeric, 4),
          'break_minutes', floor(coalesce(sb.break_seconds, 0)::numeric / 60.0),
          'approval_status', ss.approval_status,
          'approval_note', ss.approval_note,
          'approved_at', ss.approved_at,
          'schedule_codes', coalesce(to_jsonb(ss.schedule_codes), '[]'::jsonb),
          'schedule_note', ss.schedule_note,
          'manual_entry', ss.device_info = 'admin_manual_entry',
          'photo_in_path', ss.photo_in_path,
          'photo_out_path', ss.photo_out_path,
          'geo_ok_in', ss.geo_ok_in,
          'geo_ok_out', ss.geo_ok_out,
          'clock_in_distance_m', ss.clock_in_distance_m,
          'clock_out_distance_m', ss.clock_out_distance_m
        )
        order by ss.seg_start
      ) as shift_segments
    from valid_segments ss
    left join segment_breaks sb
      on sb.time_entry_id = ss.time_entry_id
     and sb.employee_id = ss.employee_id
     and sb.store_id is not distinct from ss.store_id
     and sb.work_date_local = ss.work_date_local
    group by ss.employee_id, ss.store_id, ss.store_name, ss.work_date_local, ss.paid_break_cap_min
  ),
  store_day_with_unpaid as (
    select
      sd.*,
      greatest(sd.break_seconds - (sd.paid_break_cap_min * 60), 0)::bigint as unpaid_break_seconds
    from store_day sd
  ),
  per_employee_day as (
    select
      sd.employee_id,
      sd.work_date_local,
      sum(sd.worked_seconds)::bigint as worked_seconds_day,
      sum(sd.break_seconds)::bigint as break_seconds_day,
      sum(sd.unpaid_break_seconds)::bigint as unpaid_break_seconds_day,
      public.resolve_hourly_rate(sd.employee_id, sd.work_date_local) as hourly_rate_day,
      jsonb_agg(
        jsonb_build_object(
          'store_id', sd.store_id,
          'store_name', sd.store_name,
          'worked_hours', round((sd.worked_seconds::numeric / 3600.0)::numeric, 4),
          'break_minutes', floor(sd.break_seconds::numeric / 60.0),
          'paid_break_cap_minutes', sd.paid_break_cap_min,
          'unpaid_break_minutes', floor(sd.unpaid_break_seconds::numeric / 60.0),
          'shift_segments', sd.shift_segments
        )
        order by sd.store_name
      ) as stores
    from store_day_with_unpaid sd
    group by sd.employee_id, sd.work_date_local
  ),
  per_employee_day_paid as (
    select
      d.employee_id,
      d.work_date_local,
      d.hourly_rate_day,
      d.worked_seconds_day,
      d.break_seconds_day,
      d.unpaid_break_seconds_day,
      d.stores,
      public.round_seconds(
        greatest(d.worked_seconds_day - d.unpaid_break_seconds_day, 0),
        v_run.rounding_mode
      )::bigint as paid_seconds_day,
      (
        public.week_start(
          (d.work_date_local::timestamp at time zone v_p.timezone),
          v_p.timezone,
          public.org_week_start_dow()
        ) at time zone v_p.timezone
      )::date as week_start_date
    from per_employee_day d
  ),
  day_with_prior as (
    select
      d.*,
      coalesce(
        sum(d.paid_seconds_day) over (
          partition by d.employee_id, d.week_start_date
          order by d.work_date_local
          rows between unbounded preceding and 1 preceding
        ),
        0
      )::bigint as prior_week_paid_seconds
    from per_employee_day_paid d
  ),
  day_with_ot as (
    select
      d.*,
      greatest(
        least((40 * 3600) - d.prior_week_paid_seconds, d.paid_seconds_day),
        0
      )::bigint as regular_seconds_day,
      (
        d.paid_seconds_day - greatest(
          least((40 * 3600) - d.prior_week_paid_seconds, d.paid_seconds_day),
          0
        )
      )::bigint as overtime_seconds_day
    from day_with_prior d
  ),
  shift_summary as (
    select
      rs.employee_id,
      count(distinct rs.time_entry_id)::int as shift_count,
      sum(
        case when array_length(coalesce(rs.schedule_codes, '{}'::text[]), 1) is null then 0 else 1 end
      )::int as anomaly_count,
      jsonb_agg(
        jsonb_build_object(
          'time_entry_id', rs.time_entry_id,
          'store_id', rs.store_id,
          'store_name', rs.store_name,
          'clock_in', rs.clock_in,
          'clock_out', rs.clock_out,
          'clipped_start', rs.clipped_start,
          'clipped_end', rs.clipped_end,
          'approval_status', rs.approval_status,
          'approval_note', rs.approval_note,
          'approved_at', rs.approved_at,
          'schedule_codes', coalesce(to_jsonb(rs.schedule_codes), '[]'::jsonb),
          'expected_start_ts', rs.expected_start_ts,
          'expected_end_ts', rs.expected_end_ts,
          'manual_entry', rs.device_info = 'admin_manual_entry',
          'note', rs.note,
          'photo_in_path', rs.photo_in_path,
          'photo_out_path', rs.photo_out_path,
          'geo_ok_in', rs.geo_ok_in,
          'geo_ok_out', rs.geo_ok_out
        )
        order by rs.clock_in
      ) as shift_breakdown
    from raw_shifts rs
    group by rs.employee_id
  ),
  adjustment_audit as (
    select
      rs.employee_id,
      coalesce(
        jsonb_agg(
          distinct jsonb_build_object(
            'adjustment_id', adj.id,
            'time_entry_id', adj.time_entry_id,
            'editor_user_id', adj.editor_user_id,
            'editor_name', adj.editor_name,
            'edited_at', adj.edited_at,
            'reason', adj.reason,
            'fields_changed', adj.fields_changed,
            'old_value', adj.old_value,
            'new_value', adj.new_value
          )
        ) filter (where adj.id is not null),
        '[]'::jsonb
      ) as adjustments
    from raw_shifts rs
    left join public.v_shift_adjustments adj on adj.time_entry_id = rs.time_entry_id
    group by rs.employee_id
  ),
  per_employee_period as (
    select
      x.employee_id,
      sum(x.paid_seconds_day)::bigint as paid_seconds,
      (sum(x.paid_seconds_day)::numeric / 3600.0) as paid_hours,
      sum(x.regular_seconds_day)::bigint as regular_seconds,
      sum(x.overtime_seconds_day)::bigint as overtime_seconds,
      sum((x.regular_seconds_day::numeric / 3600.0) * x.hourly_rate_day) as regular_pay,
      sum((x.overtime_seconds_day::numeric / 3600.0) * x.hourly_rate_day * 1.5) as overtime_pay,
      sum(
        ((x.regular_seconds_day::numeric / 3600.0) * x.hourly_rate_day)
        + ((x.overtime_seconds_day::numeric / 3600.0) * x.hourly_rate_day * 1.5)
      ) as gross_pay,
      (array_agg(x.hourly_rate_day order by x.work_date_local desc))[1] as hourly_rate_display,
      jsonb_agg(
        jsonb_build_object(
          'work_date', x.work_date_local,
          'week_start', x.week_start_date,
          'worked_hours', round((x.worked_seconds_day::numeric / 3600.0)::numeric, 4),
          'break_minutes', floor((x.break_seconds_day::numeric / 60.0)),
          'unpaid_break_minutes', floor((x.unpaid_break_seconds_day::numeric / 60.0)),
          'paid_hours_rounded', round((x.paid_seconds_day::numeric / 3600.0)::numeric, 4),
          'regular_hours', round((x.regular_seconds_day::numeric / 3600.0)::numeric, 4),
          'overtime_hours', round((x.overtime_seconds_day::numeric / 3600.0)::numeric, 4),
          'hourly_rate', x.hourly_rate_day,
          'regular_pay', round(((x.regular_seconds_day::numeric / 3600.0) * x.hourly_rate_day)::numeric, 2),
          'overtime_pay', round(((x.overtime_seconds_day::numeric / 3600.0) * x.hourly_rate_day * 1.5)::numeric, 2),
          'gross_for_day', round((((x.regular_seconds_day::numeric / 3600.0) * x.hourly_rate_day) + ((x.overtime_seconds_day::numeric / 3600.0) * x.hourly_rate_day * 1.5))::numeric, 2),
          'rounding_mode', v_run.rounding_mode,
          'stores', x.stores
        )
        order by x.work_date_local
      ) as day_breakdown
    from day_with_ot x
    group by x.employee_id
  )
  insert into public.payroll_run_lines (
    payroll_run_id,
    employee_id,
    paid_seconds,
    paid_hours,
    regular_seconds,
    overtime_seconds,
    regular_pay,
    overtime_pay,
    hourly_rate,
    gross_pay,
    shift_count,
    anomaly_count,
    details
  )
  select
    v_run.id,
    p.employee_id,
    p.paid_seconds,
    p.paid_hours,
    p.regular_seconds,
    p.overtime_seconds,
    round(p.regular_pay::numeric, 2),
    round(p.overtime_pay::numeric, 2),
    p.hourly_rate_display,
    round(p.gross_pay::numeric, 2),
    coalesce(ss.shift_count, 0),
    coalesce(ss.anomaly_count, 0),
    jsonb_build_object(
      'rounding_mode', v_run.rounding_mode,
      'break_policy', v_run.break_policy,
      'break_cap_source', 'store_locations.paid_break_cap_min per store/day',
      'rate_source', 'employee_rates per local work day, fallback employees.hourly_rate',
      'overtime_rule', 'weekly_after_40_hours',
      'overtime_multiplier', 1.5,
      'period_boundary_clipping', true,
      'seller_role_excluded', true,
      'period_window', jsonb_build_object('start', v_start, 'end_exclusive', v_end, 'timezone', v_p.timezone),
      'day_breakdown', p.day_breakdown,
      'shift_breakdown', coalesce(ss.shift_breakdown, '[]'::jsonb),
      'adjustments', coalesce(aa.adjustments, '[]'::jsonb)
    )
  from per_employee_period p
  left join shift_summary ss on ss.employee_id = p.employee_id
  left join adjustment_audit aa on aa.employee_id = p.employee_id;

  get diagnostics v_rows = row_count;

  if exists (
    select 1
    from public.payroll_run_lines l
    cross join lateral jsonb_array_elements(l.details->'day_breakdown') as d(day)
    where l.payroll_run_id = v_run.id
      and (d.day->>'hourly_rate') is null
  ) then
    raise exception 'Missing hourly rate for at least one employee on at least one work day in this period'
      using errcode = '22023';
  end if;

  update public.payroll_runs
  set built_at = now(),
      built_by = auth.uid(),
      rules = coalesce(rules, '{}'::jsonb) || jsonb_build_object(
        'last_build', jsonb_build_object(
          'built_at', now(),
          'built_by', auth.uid(),
          'rows', v_rows,
          'period_boundary_clipping', true,
          'overtime_rule', 'weekly_after_40_hours',
          'seller_role_excluded', true
        )
      )
  where id = v_run.id;

  return v_rows;
end;
$function$;

create or replace function public.preview_payroll_statement(_run_id uuid, _employee_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_is_admin boolean := public.is_admin();
  v_user_id uuid;
  r record;
  v_paid numeric := 0;
  v_due numeric := 0;
  v_minutes_worked int := 0;
  v_break_minutes int := 0;
  v_unpaid_break_minutes int := 0;
  v_paid_break_minutes int := 0;
  v_rounded_minutes int := 0;
  v_regular_minutes int := 0;
  v_overtime_minutes int := 0;
  v_hours_paid numeric := 0;
  v_flags jsonb := '[]'::jsonb;
  v_payments jsonb := '[]'::jsonb;
begin
  select e.user_id into v_user_id
  from public.employees e
  where e.id = _employee_id;

  if v_user_id is null then
    raise exception 'Employee not found' using errcode = '22023';
  end if;

  if (not v_is_admin) and (v_user_id <> auth.uid()) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  select
    pr.id as payroll_run_id,
    pr.status as run_status,
    pr.rounding_mode,
    pr.created_at as run_created_at,
    pr.built_at as run_built_at,
    pr.finalized_at as run_finalized_at,
    pp.id as pay_period_id,
    pp.start_date,
    pp.end_date,
    pp.timezone,
    (pp.status = 'locked') as period_locked,
    e.display_name,
    e.email,
    e.role,
    e.worker_type,
    l.employee_id,
    l.shift_count,
    l.hourly_rate,
    l.gross_pay,
    l.regular_seconds,
    l.overtime_seconds,
    l.regular_pay,
    l.overtime_pay,
    l.ss_employee,
    l.medicare_employee,
    l.addl_medicare_employee,
    l.fica_employee_total,
    l.net_pre_fed,
    l.ytd_wages,
    l.fica_year,
    l.fica_params,
    l.details,
    coalesce(p.paid_total, 0) as paid_total
  into r
  from public.payroll_runs pr
  join public.pay_periods pp on pp.id = pr.pay_period_id
  join public.payroll_run_lines l on l.payroll_run_id = pr.id and l.employee_id = _employee_id
  join public.employees e on e.id = l.employee_id
  left join (
    select payroll_run_id, employee_id, sum(amount) as paid_total
    from public.contractor_payments
    where payroll_run_id = _run_id
      and employee_id = _employee_id
      and status = 'paid'
    group by payroll_run_id, employee_id
  ) p on p.payroll_run_id = pr.id and p.employee_id = l.employee_id
  where pr.id = _run_id;

  if r.payroll_run_id is null then
    raise exception 'Run line not found' using errcode = '22023';
  end if;

  v_paid := r.paid_total;
  v_due := greatest(0, r.gross_pay - v_paid);

  if (r.details ? 'day_breakdown') then
    select
      coalesce(sum(round((d->>'worked_hours')::numeric * 60)), 0)::int,
      coalesce(sum((d->>'break_minutes')::numeric), 0)::int,
      coalesce(sum((d->>'unpaid_break_minutes')::numeric), 0)::int,
      coalesce(sum(round((d->>'paid_hours_rounded')::numeric * 60)), 0)::int,
      coalesce(sum(round((d->>'regular_hours')::numeric * 60)), 0)::int,
      coalesce(sum(round((d->>'overtime_hours')::numeric * 60)), 0)::int
    into
      v_minutes_worked,
      v_break_minutes,
      v_unpaid_break_minutes,
      v_rounded_minutes,
      v_regular_minutes,
      v_overtime_minutes
    from jsonb_array_elements(r.details->'day_breakdown') d;

    v_paid_break_minutes := greatest(0, v_break_minutes - v_unpaid_break_minutes);
  end if;

  v_hours_paid := (v_rounded_minutes::numeric / 60.0);

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', cp.id,
      'amount', cp.amount,
      'status', cp.status,
      'method', cp.method,
      'reference', cp.reference,
      'note', cp.note,
      'paid_at', cp.paid_at,
      'created_at', cp.created_at,
      'voided_at', cp.voided_at,
      'void_reason', cp.void_reason
    )
    order by cp.created_at desc
  ), '[]'::jsonb)
  into v_payments
  from public.contractor_payments cp
  where cp.payroll_run_id = _run_id
    and cp.employee_id = _employee_id;

  v_flags := (
    select coalesce(jsonb_agg(flag), '[]'::jsonb)
    from (
      select jsonb_build_object(
        'type', 'pending_review',
        'time_entry_id', te.id,
        'date', te.clock_in::date,
        'message', 'Shift pending approval'
      ) as flag
      from public.time_entries te
      left join public.shift_approvals sa on sa.time_entry_id = te.id
      where te.employee_id = _employee_id
        and te.clock_out is not null
        and te.clock_in::date between r.start_date and r.end_date
        and sa.time_entry_id is null

      union all

      select jsonb_build_object(
        'type', 'geo',
        'time_entry_id', te.id,
        'date', te.clock_in::date,
        'message', 'Geolocation check failed'
      ) as flag
      from public.time_entries te
      where te.employee_id = _employee_id
        and te.clock_in::date between r.start_date and r.end_date
        and (te.geo_ok_in = false or te.geo_ok_out = false)

      union all

      select jsonb_build_object(
        'type', 'edit',
        'time_entry_id', adj.time_entry_id,
        'date', adj.edited_at::date,
        'message', 'Shift manually adjusted'
      ) as flag
      from public.v_shift_adjustments adj
      join public.time_entries te on te.id = adj.time_entry_id
      where te.employee_id = _employee_id
        and adj.edited_at::date between r.start_date and r.end_date
    ) flags
  );

  return jsonb_build_object(
    'run', jsonb_build_object(
      'payroll_run_id', r.payroll_run_id,
      'status', r.run_status,
      'rounding_mode', r.rounding_mode,
      'created_at', r.run_created_at,
      'built_at', r.run_built_at,
      'finalized_at', r.run_finalized_at
    ),
    'pay_period', jsonb_build_object(
      'pay_period_id', r.pay_period_id,
      'start_date', r.start_date,
      'end_date', r.end_date,
      'timezone', r.timezone,
      'locked', r.period_locked
    ),
    'employee', jsonb_build_object(
      'employee_id', r.employee_id,
      'display_name', r.display_name,
      'email', r.email,
      'role', r.role,
      'worker_type', r.worker_type
    ),
    'summary', jsonb_build_object(
      'shift_count', r.shift_count,
      'hourly_rate', r.hourly_rate,
      'gross_pay', r.gross_pay,
      'regular_pay', r.regular_pay,
      'overtime_pay', r.overtime_pay,
      'paid_total', v_paid,
      'due_total', v_due,
      'minutes_worked', v_minutes_worked,
      'break_minutes', v_break_minutes,
      'paid_break_minutes', v_paid_break_minutes,
      'unpaid_break_minutes', v_unpaid_break_minutes,
      'rounded_minutes', v_rounded_minutes,
      'regular_minutes', v_regular_minutes,
      'overtime_minutes', v_overtime_minutes,
      'hours_paid', v_hours_paid
    ),
    'fica', jsonb_build_object(
      'fica_year', r.fica_year,
      'ytd_wages', r.ytd_wages,
      'ss_employee', r.ss_employee,
      'medicare_employee', r.medicare_employee,
      'addl_medicare_employee', r.addl_medicare_employee,
      'fica_employee_total', r.fica_employee_total,
      'net_pre_fed', r.net_pre_fed,
      'params', r.fica_params
    ),
    'details', coalesce(r.details, '{}'::jsonb),
    'payments', v_payments,
    'flags', v_flags
  );
end;
$function$;

create or replace function public.generate_payroll_statements_for_run(_run_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  r record;
  s jsonb;
begin
  if not public.is_admin() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  for r in
    select employee_id
    from public.payroll_run_lines
    where payroll_run_id = _run_id
  loop
    s := public.preview_payroll_statement(_run_id, r.employee_id);

    insert into public.payroll_statements (
      payroll_run_id,
      pay_period_id,
      employee_id,
      run_status,
      rounding_mode,
      hourly_rate,
      gross_pay,
      total_paid,
      total_due,
      shifts_count,
      minutes_worked,
      break_minutes,
      paid_break_minutes,
      unpaid_break_minutes,
      paid_minutes,
      rounded_minutes,
      hours_paid,
      details
    ) values (
      (s#>>'{run,payroll_run_id}')::uuid,
      (s#>>'{pay_period,pay_period_id}')::uuid,
      (s#>>'{employee,employee_id}')::uuid,
      s#>>'{run,status}',
      s#>>'{run,rounding_mode}',
      coalesce((s#>>'{summary,hourly_rate}')::numeric, 0),
      coalesce((s#>>'{summary,gross_pay}')::numeric, 0),
      coalesce((s#>>'{summary,paid_total}')::numeric, 0),
      coalesce((s#>>'{summary,due_total}')::numeric, 0),
      coalesce((s#>>'{summary,shift_count}')::int, 0),
      coalesce((s#>>'{summary,minutes_worked}')::int, 0),
      coalesce((s#>>'{summary,break_minutes}')::int, 0),
      coalesce((s#>>'{summary,paid_break_minutes}')::int, 0),
      coalesce((s#>>'{summary,unpaid_break_minutes}')::int, 0),
      coalesce((s#>>'{summary,rounded_minutes}')::int, 0),
      coalesce((s#>>'{summary,rounded_minutes}')::int, 0),
      coalesce((s#>>'{summary,hours_paid}')::numeric, 0),
      s
    )
    on conflict (payroll_run_id, employee_id)
    do update set
      run_status = excluded.run_status,
      rounding_mode = excluded.rounding_mode,
      hourly_rate = excluded.hourly_rate,
      gross_pay = excluded.gross_pay,
      total_paid = excluded.total_paid,
      total_due = excluded.total_due,
      shifts_count = excluded.shifts_count,
      minutes_worked = excluded.minutes_worked,
      break_minutes = excluded.break_minutes,
      paid_break_minutes = excluded.paid_break_minutes,
      unpaid_break_minutes = excluded.unpaid_break_minutes,
      paid_minutes = excluded.paid_minutes,
      rounded_minutes = excluded.rounded_minutes,
      hours_paid = excluded.hours_paid,
      details = excluded.details,
      created_at = now();
  end loop;
end;
$function$;

create or replace function public.finalize_payroll_run(
  _payroll_run_id uuid,
  _note text default null
)
returns public.payroll_runs
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_run public.payroll_runs;
  v_rows int;
begin
  if not public.is_admin() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  select * into v_run
  from public.payroll_runs
  where id = _payroll_run_id
  for update;

  if v_run.id is null then
    raise exception 'Payroll run not found' using errcode = '22023';
  end if;

  if v_run.status <> 'draft' then
    raise exception 'Only draft runs can be finalized' using errcode = '22023';
  end if;

  perform public.payroll_lock_period(v_run.pay_period_id, _note, false);

  v_rows := public.build_payroll_run_lines(v_run.id);
  if v_rows <= 0 then
    raise exception 'Cannot finalize: payroll run has no payable hourly lines' using errcode = '22023';
  end if;

  perform public.apply_fica_deductions_to_run(v_run.id);

  update public.payroll_runs
  set status = 'final',
      finalized_at = now(),
      finalized_by = auth.uid(),
      note = case
        when _note is null or trim(_note) = '' then note
        else coalesce(note, '') || case when note is null then '' else E'\n' end || _note
      end
  where id = v_run.id
  returning * into v_run;

  perform public.generate_payroll_statements_for_run(v_run.id);

  return v_run;
end;
$function$;

create or replace function public.record_contractor_payment(
  _payroll_run_id uuid,
  _employee_id uuid,
  _amount numeric,
  _method text default 'other',
  _reference text default null,
  _note text default null,
  _paid_at timestamptz default now()
)
returns public.contractor_payments
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_run public.payroll_runs;
  v_line public.payroll_run_lines;
  v_paid numeric := 0;
  v_due numeric := 0;
  v_row public.contractor_payments;
begin
  if not public.is_admin() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  select * into v_run
  from public.payroll_runs
  where id = _payroll_run_id;

  if v_run.id is null then
    raise exception 'Payroll run not found' using errcode = '22023';
  end if;

  if v_run.status <> 'final' then
    raise exception 'Payments can only be recorded for FINAL runs' using errcode = '22023';
  end if;

  select * into v_line
  from public.payroll_run_lines
  where payroll_run_id = _payroll_run_id
    and employee_id = _employee_id;

  if v_line.id is null then
    raise exception 'Payroll line not found for this employee' using errcode = '22023';
  end if;

  if _amount is null or _amount <= 0 then
    raise exception 'amount must be greater than 0' using errcode = '22023';
  end if;

  if _method not in ('zelle', 'ach', 'wire', 'cash', 'check', 'other') then
    raise exception 'Invalid method' using errcode = '22023';
  end if;

  select coalesce(sum(amount), 0) into v_paid
  from public.contractor_payments
  where payroll_run_id = _payroll_run_id
    and employee_id = _employee_id
    and status = 'paid';

  v_due := greatest(0, coalesce(v_line.gross_pay, 0) - v_paid);

  if _amount > v_due + 0.009 then
    raise exception 'Payment exceeds remaining due amount (%).', round(v_due, 2)
      using errcode = '22023';
  end if;

  insert into public.contractor_payments (
    pay_period_id,
    payroll_run_id,
    employee_id,
    amount,
    status,
    method,
    reference,
    note,
    paid_at,
    paid_by
  ) values (
    v_run.pay_period_id,
    _payroll_run_id,
    _employee_id,
    round(_amount::numeric, 2),
    'paid',
    _method,
    nullif(btrim(_reference), ''),
    nullif(btrim(_note), ''),
    coalesce(_paid_at, now()),
    auth.uid()
  )
  returning * into v_row;

  insert into public.payroll_payment_audits (
    contractor_payment_id,
    payroll_run_id,
    employee_id,
    action,
    actor_user_id,
    reason,
    new_value
  ) values (
    v_row.id,
    v_row.payroll_run_id,
    v_row.employee_id,
    'record_payment',
    auth.uid(),
    coalesce(nullif(btrim(_note), ''), 'Payment recorded'),
    to_jsonb(v_row)
  );

  perform public.generate_payroll_statements_for_run(_payroll_run_id);

  return v_row;
end;
$function$;

create or replace function public.void_contractor_payment(
  _payment_id uuid,
  _reason text
)
returns public.contractor_payments
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_old public.contractor_payments;
  v_new public.contractor_payments;
begin
  if not public.is_admin() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  if length(btrim(coalesce(_reason, ''))) < 3 then
    raise exception 'Reason is required (min 3 characters)' using errcode = '22023';
  end if;

  select * into v_old
  from public.contractor_payments
  where id = _payment_id
  for update;

  if v_old.id is null then
    raise exception 'Payment not found' using errcode = '22023';
  end if;

  if v_old.status = 'void' then
    return v_old;
  end if;

  update public.contractor_payments
  set status = 'void',
      voided_at = now(),
      voided_by = auth.uid(),
      void_reason = btrim(_reason)
  where id = v_old.id
  returning * into v_new;

  insert into public.payroll_payment_audits (
    contractor_payment_id,
    payroll_run_id,
    employee_id,
    action,
    actor_user_id,
    reason,
    old_value,
    new_value
  ) values (
    v_new.id,
    v_new.payroll_run_id,
    v_new.employee_id,
    'void_payment',
    auth.uid(),
    btrim(_reason),
    to_jsonb(v_old),
    to_jsonb(v_new)
  );

  if v_new.payroll_run_id is not null then
    perform public.generate_payroll_statements_for_run(v_new.payroll_run_id);
  end if;

  return v_new;
end;
$function$;

revoke all on function public.payroll_period_readiness(uuid) from public;
revoke all on function public.void_contractor_payment(uuid, text) from public;

grant execute on function public.payroll_period_readiness(uuid) to authenticated;
grant execute on function public.void_contractor_payment(uuid, text) to authenticated;
