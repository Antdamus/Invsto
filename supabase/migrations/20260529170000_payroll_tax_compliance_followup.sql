-- Follow-up for payroll tax compliance changes made after
-- 20260529160000_payroll_tax_compliance_foundation.sql may already have run.
-- Supabase will not re-run an edited migration filename, so this migration
-- carries the corrected functions/backfills under a new name.

alter table public.store_locations
  add column if not exists address_line1 text,
  add column if not exists address_line2 text,
  add column if not exists city text,
  add column if not exists county text,
  add column if not exists state text,
  add column if not exists postal_code text,
  add column if not exists country text not null default 'US',
  add column if not exists tax_location_code text,
  add column if not exists withholding_state text,
  add column if not exists unemployment_state text,
  add column if not exists local_tax_code text;

update public.store_locations
set state = coalesce(nullif(state, ''), 'FL'),
    withholding_state = coalesce(nullif(withholding_state, ''), 'FL'),
    unemployment_state = coalesce(nullif(unemployment_state, ''), 'FL'),
    country = coalesce(nullif(country, ''), 'US')
where active is true
  and coalesce(nullif(state, ''), nullif(withholding_state, ''), nullif(unemployment_state, '')) is null;

create or replace function public.payroll_required_tax_profile_blockers(_period_id uuid, _strict boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_p public.pay_periods;
  v_start timestamptz;
  v_end timestamptz;
  v_missing_work_locations int := 0;
  v_missing_employee_addresses int := 0;
  v_missing_tax_ids int := 0;
  v_missing_i9 int := 0;
  v_missing_w4 int := 0;
  v_missing_state_accounts int := 0;
  v_pending_state_withholding_engine int := 0;
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

  with payable_employees as (
    select distinct t.employee_id
    from public.time_entries t
    join public.employees e on e.id = t.employee_id
    where t.clock_out is not null
      and t.clock_in < v_end
      and t.clock_out > v_start
      and lower(coalesce(e.worker_type, 'employee')) = 'employee'
      and lower(coalesce(e.role, '')) <> 'seller'
  ),
  payable_stores as (
    select distinct t.store_id
    from public.time_entries t
    join payable_employees pe on pe.employee_id = t.employee_id
    where t.store_id is not null
      and t.clock_out is not null
      and t.clock_in < v_end
      and t.clock_out > v_start
  ),
  work_states as (
    select distinct upper(coalesce(nullif(s.unemployment_state, ''), nullif(s.withholding_state, ''), nullif(s.state, ''))) as state_code
    from public.store_locations s
    join payable_stores ps on ps.store_id = s.id
    where upper(coalesce(nullif(s.unemployment_state, ''), nullif(s.withholding_state, ''), nullif(s.state, ''))) is not null
  )
  select
    (select count(*)
     from payable_stores ps
     join public.store_locations s on s.id = ps.store_id
     where nullif(btrim(coalesce(nullif(s.state, ''), nullif(s.withholding_state, ''), nullif(s.unemployment_state, ''), '')), '') is null),
    (select count(*)
     from payable_employees pe
     where not exists (
       select 1
       from public.employee_legal_addresses a
       where a.employee_id = pe.employee_id
         and a.is_current is true
         and nullif(btrim(coalesce(a.state, '')), '') is not null
         and nullif(btrim(coalesce(a.postal_code, '')), '') is not null
     )),
    (select count(*)
     from payable_employees pe
     where not exists (
       select 1
       from public.employee_sensitive_tax_ids tin
       where tin.employee_id = pe.employee_id
         and tin.active is true
         and (tin.encrypted_ref is not null or nullif(btrim(coalesce(tin.tin_last4, '')), '') is not null)
     )),
    (select count(*)
     from payable_employees pe
     where not exists (
       select 1
       from public.employee_employment_compliance c
       where c.employee_id = pe.employee_id
         and c.i9_status in ('complete','not_required')
     )),
    (select count(*)
     from payable_employees pe
     where not exists (
       select 1
       from public.employee_federal_withholding_elections w4
       where w4.employee_id = pe.employee_id
         and w4.status = 'active'
         and w4.effective_from <= v_p.end_date
         and (w4.effective_to is null or w4.effective_to >= v_p.start_date)
     )),
    (select count(*)
     from work_states ws
     where ws.state_code is not null
       and not exists (
         select 1
         from public.employer_state_tax_accounts a
         where a.state_code = ws.state_code
           and a.active is true
           and a.effective_from <= v_p.end_date
           and (a.effective_to is null or a.effective_to >= v_p.start_date)
       )),
    (select count(*)
     from work_states ws
     join public.payroll_tax_jurisdictions j
       on j.tax_year = extract(year from v_p.end_date)::int
      and j.jurisdiction_code = ws.state_code
     where j.taxes#>>'{state_income_tax,engine}' not in ('none'))
  into
    v_missing_work_locations,
    v_missing_employee_addresses,
    v_missing_tax_ids,
    v_missing_i9,
    v_missing_w4,
    v_missing_state_accounts,
    v_pending_state_withholding_engine;

  return jsonb_build_object(
    'period_id', v_p.id,
    'strict', coalesce(_strict, false),
    'missing_work_location_tax_addresses', v_missing_work_locations,
    'missing_employee_legal_addresses', v_missing_employee_addresses,
    'missing_employee_tax_ids', v_missing_tax_ids,
    'missing_i9', v_missing_i9,
    'missing_w4', v_missing_w4,
    'missing_state_tax_accounts', v_missing_state_accounts,
    'pending_state_withholding_engine', v_pending_state_withholding_engine,
    'ready', case
      when coalesce(_strict, false) then (
        v_missing_work_locations = 0
        and v_missing_employee_addresses = 0
        and v_missing_tax_ids = 0
        and v_missing_i9 = 0
        and v_missing_w4 = 0
        and v_missing_state_accounts = 0
        and v_pending_state_withholding_engine = 0
      )
      else (
        v_missing_work_locations = 0
        and v_pending_state_withholding_engine = 0
      )
    end,
    'warnings', jsonb_build_object(
      'missing_w4_uses_irs_default_single_no_adjustments', v_missing_w4,
      'missing_state_account_uses_new_employer_estimate', v_missing_state_accounts,
      'missing_i9_should_be_fixed_before_production', v_missing_i9,
      'missing_tax_id_blocks_w2_filing', v_missing_tax_ids
    )
  );
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
  v_tax_ready jsonb;
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

  v_tax_ready := public.payroll_required_tax_profile_blockers(v_run.pay_period_id, false);
  if coalesce((v_tax_ready->>'ready')::boolean, false) is false then
    raise exception 'Cannot finalize payroll: tax setup blockers exist: %', v_tax_ready::text
      using errcode = '22023';
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
  v_payable numeric := 0;
  v_due numeric := 0;
  v_minutes_worked int := 0;
  v_break_minutes int := 0;
  v_unpaid_break_minutes int := 0;
  v_paid_break_minutes int := 0;
  v_rounded_minutes int := 0;
  v_regular_minutes int := 0;
  v_overtime_minutes int := 0;
  v_hours_paid numeric := 0;
  v_payments jsonb := '[]'::jsonb;
  v_flags jsonb := '[]'::jsonb;
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
    l.*
  into r
  from public.payroll_runs pr
  join public.pay_periods pp on pp.id = pr.pay_period_id
  join public.payroll_run_lines l on l.payroll_run_id = pr.id and l.employee_id = _employee_id
  join public.employees e on e.id = l.employee_id
  where pr.id = _run_id;

  if r.payroll_run_id is null then
    raise exception 'Run line not found' using errcode = '22023';
  end if;

  select coalesce(sum(amount), 0) into v_paid
  from public.contractor_payments
  where payroll_run_id = _run_id
    and employee_id = _employee_id
    and status = 'paid';

  v_payable := case
    when lower(coalesce(r.worker_type, 'employee')) = 'employee' then
      coalesce(r.net_pay, r.net_pre_fed, r.gross_pay, 0)
    else
      coalesce(r.gross_pay, 0)
  end;
  v_due := greatest(0, v_payable - v_paid);

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
      'payable_total', v_payable,
      'minutes_worked', v_minutes_worked,
      'break_minutes', v_break_minutes,
      'paid_break_minutes', v_paid_break_minutes,
      'unpaid_break_minutes', v_unpaid_break_minutes,
      'rounded_minutes', v_rounded_minutes,
      'regular_minutes', v_regular_minutes,
      'overtime_minutes', v_overtime_minutes,
      'hours_paid', v_hours_paid
    ),
    'taxes', jsonb_build_object(
      'federal_income_tax', coalesce(r.federal_income_tax, 0),
      'state_income_tax', coalesce(r.state_income_tax, 0),
      'local_income_tax', coalesce(r.local_income_tax, 0),
      'employee_tax_total', coalesce(r.employee_tax_total, 0),
      'net_pay', coalesce(r.net_pay, r.net_pre_fed, r.gross_pay, 0),
      'ss_employer', coalesce(r.ss_employer, 0),
      'medicare_employer', coalesce(r.medicare_employer, 0),
      'fica_employer_total', coalesce(r.fica_employer_total, 0),
      'futa_employer', coalesce(r.futa_employer, 0),
      'suta_state', r.suta_state,
      'suta_employer', coalesce(r.suta_employer, 0),
      'employer_tax_total', coalesce(r.employer_tax_total, 0),
      'total_tax_liability', coalesce(r.total_tax_liability, 0),
      'details', coalesce(r.tax_details, '{}'::jsonb)
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

grant execute on function public.payroll_required_tax_profile_blockers(uuid, boolean) to authenticated;
grant execute on function public.finalize_payroll_run(uuid, text) to authenticated;
grant execute on function public.preview_payroll_statement(uuid, uuid) to authenticated;
