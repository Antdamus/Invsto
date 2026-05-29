-- Florida employee payroll readiness.
-- This follow-up makes Florida payroll setup a hard gate for final payroll.

insert into public.payroll_tax_jurisdictions (
  tax_year,
  jurisdiction_code,
  jurisdiction_type,
  state_code,
  locality,
  taxes,
  source_label,
  source_url,
  source_retrieved_on
) values (
  2026,
  'FL',
  'state',
  'FL',
  null,
  jsonb_build_object(
    'state_income_tax', jsonb_build_object('engine', 'none', 'employee_withholding_required', false),
    'unemployment', jsonb_build_object(
      'agency_code', 'FL_DOR',
      'form', 'RT-6',
      'wage_base', 7000,
      'new_employer_rate', 0.027,
      'min_rate', 0.001,
      'max_rate', 0.054
    )
  ),
  'Florida Department of Revenue Reemployment Tax',
  'https://floridarevenue.com/taxes/taxesfees/Pages/rt_rate.aspx',
  date '2026-05-29'
)
on conflict (tax_year, jurisdiction_code) do update set
  taxes = excluded.taxes,
  source_label = excluded.source_label,
  source_url = excluded.source_url,
  source_retrieved_on = excluded.source_retrieved_on,
  active = true,
  updated_at = now();

create or replace function public.payroll_florida_employee_readiness(_period_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_p public.pay_periods;
  v_start timestamptz;
  v_end timestamptz;
  v_profile public.employer_profiles%rowtype;
  v_fl_account public.employer_state_tax_accounts%rowtype;
  v_employee_checks jsonb := '[]'::jsonb;
  v_work_locations jsonb := '[]'::jsonb;
  v_payable_employees int := 0;
  v_missing_legal_address int := 0;
  v_missing_tax_id int := 0;
  v_missing_i9 int := 0;
  v_missing_w4 int := 0;
  v_non_fl_work_locations int := 0;
  v_missing_store_tax_state int := 0;
  v_missing_profile int := 0;
  v_missing_ein int := 0;
  v_missing_fl_account int := 0;
  v_eftps_not_marked int := 0;
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

  select *
  into v_profile
  from public.employer_profiles
  where active is true
  order by created_at desc
  limit 1;

  select *
  into v_fl_account
  from public.employer_state_tax_accounts
  where active is true
    and state_code = 'FL'
    and effective_from <= v_p.end_date
    and (effective_to is null or effective_to >= v_p.start_date)
  order by effective_from desc, created_at desc
  limit 1;

  with payable_employees as (
    select distinct e.id, e.display_name, e.email, e.hourly_rate
    from public.time_entries t
    join public.employees e on e.id = t.employee_id
    where t.clock_out is not null
      and t.clock_in < v_end
      and t.clock_out > v_start
      and lower(coalesce(e.worker_type, 'employee')) = 'employee'
      and lower(coalesce(e.role, '')) <> 'seller'
  ),
  checks as (
    select
      pe.id as employee_id,
      pe.display_name,
      pe.email,
      pe.hourly_rate,
      la.state as legal_state,
      la.postal_code as legal_postal_code,
      (la.id is not null) as has_legal_address,
      (tin.id is not null) as has_tax_id,
      coalesce(tin.verification_status, 'missing') as tax_id_status,
      coalesce(ec.i9_status, 'missing') as i9_status,
      (coalesce(ec.i9_status, 'missing') in ('complete', 'not_required')) as has_i9,
      (w4.id is not null) as has_w4,
      w4.filing_status as w4_filing_status
    from payable_employees pe
    left join lateral (
      select *
      from public.employee_legal_addresses a
      where a.employee_id = pe.id
        and a.is_current is true
      order by a.created_at desc
      limit 1
    ) la on true
    left join lateral (
      select *
      from public.employee_sensitive_tax_ids t
      where t.employee_id = pe.id
        and t.active is true
        and (t.encrypted_ref is not null or nullif(btrim(coalesce(t.tin_last4, '')), '') is not null)
      order by t.created_at desc
      limit 1
    ) tin on true
    left join public.employee_employment_compliance ec on ec.employee_id = pe.id
    left join lateral (
      select *
      from public.employee_federal_withholding_elections w
      where w.employee_id = pe.id
        and w.status = 'active'
        and w.effective_from <= v_p.end_date
        and (w.effective_to is null or w.effective_to >= v_p.start_date)
      order by w.effective_from desc, w.created_at desc
      limit 1
    ) w4 on true
  )
  select
    count(*),
    count(*) filter (where not has_legal_address),
    count(*) filter (where not has_tax_id),
    count(*) filter (where not has_i9),
    count(*) filter (where not has_w4),
    coalesce(jsonb_agg(
      jsonb_build_object(
        'employee_id', employee_id,
        'display_name', display_name,
        'email', email,
        'hourly_rate', hourly_rate,
        'has_legal_address', has_legal_address,
        'legal_state', legal_state,
        'legal_postal_code', legal_postal_code,
        'has_tax_id', has_tax_id,
        'tax_id_status', tax_id_status,
        'has_i9', has_i9,
        'i9_status', i9_status,
        'has_w4', has_w4,
        'w4_filing_status', w4_filing_status,
        'ready', has_legal_address and has_tax_id and has_i9 and has_w4
      )
      order by display_name
    ), '[]'::jsonb)
  into
    v_payable_employees,
    v_missing_legal_address,
    v_missing_tax_id,
    v_missing_i9,
    v_missing_w4,
    v_employee_checks
  from checks;

  with payable_stores as (
    select distinct s.id, s.name,
      upper(coalesce(nullif(s.unemployment_state, ''), nullif(s.withholding_state, ''), nullif(s.state, ''))) as work_state,
      s.state,
      s.withholding_state,
      s.unemployment_state
    from public.time_entries t
    join public.employees e on e.id = t.employee_id
    left join public.store_locations s on s.id = t.store_id
    where t.clock_out is not null
      and t.clock_in < v_end
      and t.clock_out > v_start
      and lower(coalesce(e.worker_type, 'employee')) = 'employee'
      and lower(coalesce(e.role, '')) <> 'seller'
  )
  select
    count(*) filter (where work_state is null),
    count(*) filter (where work_state is not null and work_state <> 'FL'),
    coalesce(jsonb_agg(
      jsonb_build_object(
        'store_id', id,
        'name', name,
        'work_state', work_state,
        'state', state,
        'withholding_state', withholding_state,
        'unemployment_state', unemployment_state,
        'ready', work_state = 'FL'
      )
      order by name
    ), '[]'::jsonb)
  into v_missing_store_tax_state, v_non_fl_work_locations, v_work_locations
  from payable_stores;

  v_missing_profile := case when v_profile.id is null then 1 else 0 end;
  v_missing_ein := case
    when v_profile.id is null then 1
    when nullif(btrim(coalesce(v_profile.ein_last4, '')), '') is null and nullif(btrim(coalesce(v_profile.ein_encrypted_ref, '')), '') is null then 1
    else 0
  end;
  v_eftps_not_marked := case when coalesce(v_profile.eftps_enrolled, false) is false then 1 else 0 end;
  v_missing_fl_account := case
    when v_fl_account.id is null then 1
    when v_fl_account.suta_rate is null or v_fl_account.suta_wage_base is null then 1
    else 0
  end;

  return jsonb_build_object(
    'period_id', v_p.id,
    'state', 'FL',
    'payable_employees', v_payable_employees,
    'ready', (
      v_payable_employees > 0
      and v_missing_profile = 0
      and v_missing_ein = 0
      and v_missing_fl_account = 0
      and v_missing_store_tax_state = 0
      and v_non_fl_work_locations = 0
      and v_missing_legal_address = 0
      and v_missing_tax_id = 0
      and v_missing_i9 = 0
      and v_missing_w4 = 0
    ),
    'blockers', jsonb_build_object(
      'missing_employer_profile', v_missing_profile,
      'missing_employer_ein', v_missing_ein,
      'missing_fl_reemployment_account', v_missing_fl_account,
      'missing_store_tax_state', v_missing_store_tax_state,
      'non_florida_work_locations', v_non_fl_work_locations,
      'missing_employee_legal_addresses', v_missing_legal_address,
      'missing_employee_tax_ids', v_missing_tax_id,
      'missing_i9', v_missing_i9,
      'missing_w4', v_missing_w4
    ),
    'warnings', jsonb_build_object(
      'eftps_not_marked_enrolled', v_eftps_not_marked
    ),
    'employer', jsonb_build_object(
      'profile_id', v_profile.id,
      'legal_name', v_profile.legal_name,
      'ein_last4', v_profile.ein_last4,
      'federal_deposit_schedule', v_profile.federal_deposit_schedule,
      'federal_return_type', v_profile.federal_return_type,
      'eftps_enrolled', coalesce(v_profile.eftps_enrolled, false),
      'fl_account_id', v_fl_account.id,
      'fl_unemployment_account_id_last4', v_fl_account.unemployment_account_id_last4,
      'fl_suta_rate', v_fl_account.suta_rate,
      'fl_suta_wage_base', v_fl_account.suta_wage_base
    ),
    'work_locations', v_work_locations,
    'employees', v_employee_checks
  );
end;
$function$;

create or replace function public.payroll_period_readiness(_period_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_ops jsonb;
  v_fl jsonb;
  v_fl_blockers jsonb;
begin
  if not public.is_admin() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  v_ops := public.payroll_operational_readiness(_period_id);
  v_fl := public.payroll_florida_employee_readiness(_period_id);
  v_fl_blockers := coalesce(v_fl->'blockers', '{}'::jsonb);

  return v_ops || jsonb_build_object(
    'florida_readiness', v_fl,
    'missing_employer_profile', coalesce((v_fl_blockers->>'missing_employer_profile')::int, 0),
    'missing_employer_ein', coalesce((v_fl_blockers->>'missing_employer_ein')::int, 0),
    'missing_fl_reemployment_account', coalesce((v_fl_blockers->>'missing_fl_reemployment_account')::int, 0),
    'missing_store_tax_state', coalesce((v_fl_blockers->>'missing_store_tax_state')::int, 0),
    'non_florida_work_locations', coalesce((v_fl_blockers->>'non_florida_work_locations')::int, 0),
    'missing_employee_legal_addresses', coalesce((v_fl_blockers->>'missing_employee_legal_addresses')::int, 0),
    'missing_employee_tax_ids', coalesce((v_fl_blockers->>'missing_employee_tax_ids')::int, 0),
    'missing_i9', coalesce((v_fl_blockers->>'missing_i9')::int, 0),
    'missing_w4', coalesce((v_fl_blockers->>'missing_w4')::int, 0),
    'ready', coalesce((v_ops->>'ready')::boolean, false) and coalesce((v_fl->>'ready')::boolean, false)
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
  v_readiness jsonb;
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

  v_readiness := public.payroll_period_readiness(v_run.pay_period_id);
  if coalesce((v_readiness->>'ready')::boolean, false) is false then
    raise exception 'Cannot finalize payroll: Florida payroll readiness blockers exist: %', v_readiness::text
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

grant execute on function public.payroll_florida_employee_readiness(uuid) to authenticated;
grant execute on function public.payroll_period_readiness(uuid) to authenticated;
grant execute on function public.finalize_payroll_run(uuid, text) to authenticated;
