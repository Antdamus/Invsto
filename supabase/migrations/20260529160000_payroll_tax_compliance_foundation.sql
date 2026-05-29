-- Payroll tax compliance foundation.
-- Adds jurisdiction data, structured withholding profiles, employer tax accounts,
-- employee/employer tax calculations, liabilities, and net-pay payment controls.

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

alter table public.payroll_tax_constants
  add column if not exists ss_employee_rate numeric not null default 0.062,
  add column if not exists ss_employer_rate numeric not null default 0.062,
  add column if not exists medicare_employee_rate numeric not null default 0.0145,
  add column if not exists medicare_employer_rate numeric not null default 0.0145,
  add column if not exists addl_medicare_employee_rate numeric not null default 0.009,
  add column if not exists futa_wage_base numeric not null default 7000,
  add column if not exists futa_gross_rate numeric not null default 0.06,
  add column if not exists futa_standard_credit numeric not null default 0.054,
  add column if not exists futa_net_rate numeric not null default 0.006,
  add column if not exists source_url text,
  add column if not exists source_retrieved_on date;

insert into public.payroll_tax_constants (
  tax_year,
  ss_wage_base,
  addl_medicare_threshold,
  ss_employee_rate,
  ss_employer_rate,
  medicare_employee_rate,
  medicare_employer_rate,
  addl_medicare_employee_rate,
  futa_wage_base,
  futa_gross_rate,
  futa_standard_credit,
  futa_net_rate,
  source_url,
  source_retrieved_on
) values (
  2026,
  184500,
  200000,
  0.062,
  0.062,
  0.0145,
  0.0145,
  0.009,
  7000,
  0.06,
  0.054,
  0.006,
  'https://www.irs.gov/publications/p15',
  date '2026-05-29'
)
on conflict (tax_year) do update set
  ss_wage_base = excluded.ss_wage_base,
  addl_medicare_threshold = excluded.addl_medicare_threshold,
  ss_employee_rate = excluded.ss_employee_rate,
  ss_employer_rate = excluded.ss_employer_rate,
  medicare_employee_rate = excluded.medicare_employee_rate,
  medicare_employer_rate = excluded.medicare_employer_rate,
  addl_medicare_employee_rate = excluded.addl_medicare_employee_rate,
  futa_wage_base = excluded.futa_wage_base,
  futa_gross_rate = excluded.futa_gross_rate,
  futa_standard_credit = excluded.futa_standard_credit,
  futa_net_rate = excluded.futa_net_rate,
  source_url = excluded.source_url,
  source_retrieved_on = excluded.source_retrieved_on;

create table if not exists public.employer_profiles (
  id uuid primary key default gen_random_uuid(),
  legal_name text not null,
  ein_last4 text,
  ein_encrypted_ref text,
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  postal_code text,
  country text not null default 'US',
  payroll_contact_name text,
  payroll_contact_email text,
  payroll_contact_phone text,
  default_pay_frequency text not null default 'biweekly'
    check (default_pay_frequency in ('weekly','biweekly','semimonthly','monthly')),
  federal_deposit_schedule text not null default 'monthly'
    check (federal_deposit_schedule in ('monthly','semiweekly','next_day','unknown')),
  federal_return_type text not null default '941'
    check (federal_return_type in ('941','944')),
  eftps_enrolled boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);

alter table public.employer_profiles enable row level security;

drop policy if exists employer_profiles_admin_all on public.employer_profiles;
create policy employer_profiles_admin_all
  on public.employer_profiles
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create unique index if not exists employer_profiles_one_active
  on public.employer_profiles (active)
  where active is true;

create table if not exists public.employer_state_tax_accounts (
  id uuid primary key default gen_random_uuid(),
  employer_profile_id uuid references public.employer_profiles(id) on delete cascade,
  state_code text not null,
  withholding_account_id_last4 text,
  unemployment_account_id_last4 text,
  suta_rate numeric,
  suta_wage_base numeric,
  state_withholding_deposit_schedule text,
  unemployment_deposit_schedule text,
  effective_from date not null default date '2026-01-01',
  effective_to date,
  source_label text,
  source_url text,
  note text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  check (state_code = upper(state_code)),
  check (effective_to is null or effective_to >= effective_from),
  check (suta_rate is null or suta_rate >= 0),
  check (suta_wage_base is null or suta_wage_base > 0)
);

alter table public.employer_state_tax_accounts enable row level security;

drop policy if exists employer_state_tax_accounts_admin_all on public.employer_state_tax_accounts;
create policy employer_state_tax_accounts_admin_all
  on public.employer_state_tax_accounts
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create index if not exists employer_state_tax_accounts_state_idx
  on public.employer_state_tax_accounts (state_code, effective_from desc)
  where active is true;

create table if not exists public.employee_sensitive_tax_ids (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  tin_type text not null default 'ssn' check (tin_type in ('ssn','itin','ein','unknown')),
  tin_last4 text,
  encrypted_ref text,
  verification_status text not null default 'pending'
    check (verification_status in ('pending','verified','mismatch','missing')),
  verified_at timestamptz,
  verified_by uuid references auth.users(id),
  source_tax_doc_id uuid references public.employee_tax_docs(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);

alter table public.employee_sensitive_tax_ids enable row level security;

drop policy if exists employee_sensitive_tax_ids_admin_all on public.employee_sensitive_tax_ids;
create policy employee_sensitive_tax_ids_admin_all
  on public.employee_sensitive_tax_ids
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create unique index if not exists employee_sensitive_tax_ids_one_active
  on public.employee_sensitive_tax_ids (employee_id)
  where active is true;

create table if not exists public.employee_federal_withholding_elections (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  effective_from date not null default current_date,
  effective_to date,
  w4_year int not null default 2026,
  filing_status text not null default 'single_or_married_filing_separately'
    check (filing_status in ('single_or_married_filing_separately','married_filing_jointly','head_of_household')),
  multiple_jobs_step2 boolean not null default false,
  step3_credits numeric not null default 0,
  step4a_other_income numeric not null default 0,
  step4b_deductions numeric not null default 0,
  step4c_extra_withholding numeric not null default 0,
  exempt_federal boolean not null default false,
  nonresident_alien boolean not null default false,
  signed_at timestamptz,
  source_tax_doc_id uuid references public.employee_tax_docs(id) on delete set null,
  status text not null default 'active' check (status in ('active','superseded','revoked','invalid')),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from),
  check (step3_credits >= 0),
  check (step4a_other_income >= 0),
  check (step4b_deductions >= 0),
  check (step4c_extra_withholding >= 0)
);

alter table public.employee_federal_withholding_elections enable row level security;

drop policy if exists employee_federal_withholding_elections_admin_all on public.employee_federal_withholding_elections;
create policy employee_federal_withholding_elections_admin_all
  on public.employee_federal_withholding_elections
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create index if not exists employee_federal_withholding_effective_idx
  on public.employee_federal_withholding_elections (employee_id, effective_from desc)
  where status = 'active';

create table if not exists public.employee_state_withholding_elections (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  state_code text not null,
  effective_from date not null default current_date,
  effective_to date,
  filing_status text,
  allowances jsonb not null default '{}'::jsonb,
  extra_withholding numeric not null default 0,
  exempt boolean not null default false,
  nonresident_allocation jsonb not null default '{}'::jsonb,
  source_tax_doc_id uuid references public.employee_tax_docs(id) on delete set null,
  status text not null default 'active' check (status in ('active','superseded','revoked','invalid')),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  check (state_code = upper(state_code)),
  check (effective_to is null or effective_to >= effective_from),
  check (extra_withholding >= 0)
);

alter table public.employee_state_withholding_elections enable row level security;

drop policy if exists employee_state_withholding_elections_admin_all on public.employee_state_withholding_elections;
create policy employee_state_withholding_elections_admin_all
  on public.employee_state_withholding_elections
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create index if not exists employee_state_withholding_effective_idx
  on public.employee_state_withholding_elections (employee_id, state_code, effective_from desc)
  where status = 'active';

create table if not exists public.employee_employment_compliance (
  employee_id uuid primary key references public.employees(id) on delete cascade,
  i9_status text not null default 'missing'
    check (i9_status in ('missing','complete','needs_reverification','expired','not_required')),
  i9_completed_at timestamptz,
  i9_reverification_due date,
  e_verify_status text not null default 'not_started'
    check (e_verify_status in ('not_started','case_open','authorized','tentative_nonconfirmation','final_nonconfirmation','not_required')),
  e_verify_case_number_last4 text,
  e_verify_completed_at timestamptz,
  onboarding_ready_at timestamptz,
  note text,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

alter table public.employee_employment_compliance enable row level security;

drop policy if exists employee_employment_compliance_admin_all on public.employee_employment_compliance;
create policy employee_employment_compliance_admin_all
  on public.employee_employment_compliance
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create table if not exists public.payroll_tax_jurisdictions (
  id uuid primary key default gen_random_uuid(),
  tax_year int not null,
  jurisdiction_code text not null,
  jurisdiction_type text not null check (jurisdiction_type in ('federal','state','local')),
  state_code text,
  locality text,
  taxes jsonb not null default '{}'::jsonb,
  source_label text,
  source_url text,
  source_retrieved_on date,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tax_year, jurisdiction_code)
);

alter table public.payroll_tax_jurisdictions enable row level security;

drop policy if exists payroll_tax_jurisdictions_admin_all on public.payroll_tax_jurisdictions;
create policy payroll_tax_jurisdictions_admin_all
  on public.payroll_tax_jurisdictions
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists payroll_tax_jurisdictions_staff_select on public.payroll_tax_jurisdictions;
create policy payroll_tax_jurisdictions_staff_select
  on public.payroll_tax_jurisdictions
  for select
  to authenticated
  using (true);

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
) values
(
  2026,
  'FED',
  'federal',
  null,
  null,
  jsonb_build_object(
    'income_tax', jsonb_build_object('engine', 'irs_pub_15t_percentage_method_2026'),
    'social_security', jsonb_build_object('employee_rate', 0.062, 'employer_rate', 0.062, 'wage_base', 184500),
    'medicare', jsonb_build_object('employee_rate', 0.0145, 'employer_rate', 0.0145, 'additional_employee_rate', 0.009, 'additional_threshold', 200000),
    'futa', jsonb_build_object('wage_base', 7000, 'gross_rate', 0.06, 'standard_credit', 0.054, 'net_rate', 0.006)
  ),
  'IRS Publication 15 and Publication 15-T',
  'https://www.irs.gov/publications/p15',
  date '2026-05-29'
),
(
  2026,
  'FL',
  'state',
  'FL',
  null,
  jsonb_build_object(
    'state_income_tax', jsonb_build_object('engine', 'none', 'employee_withholding_required', false),
    'unemployment', jsonb_build_object('agency_code', 'FL_DOR', 'form', 'RT-6', 'wage_base', 7000, 'new_employer_rate', 0.027, 'min_rate', 0.001, 'max_rate', 0.054)
  ),
  'Florida Department of Revenue Reemployment Tax',
  'https://floridarevenue.com/taxes/taxesfees/Pages/rt_rate.aspx',
  date '2026-05-29'
),
(
  2026,
  'CT',
  'state',
  'CT',
  null,
  jsonb_build_object(
    'state_income_tax', jsonb_build_object('engine', 'pending_ct_drs_tables', 'employee_withholding_required', true),
    'unemployment', jsonb_build_object('agency_code', 'CT_DOL', 'wage_base', 27000, 'new_employer_rate', 0.019, 'min_rate', 0.011, 'max_rate', 0.099)
  ),
  'Connecticut DRS/DOL withholding and unemployment',
  'https://portal.ct.gov/dol/knowledge-base/articles/unemployment-taxes/tax-rates-and-taxable-wage-base',
  date '2026-05-29'
),
(
  2026,
  'NY',
  'state',
  'NY',
  null,
  jsonb_build_object(
    'state_income_tax', jsonb_build_object('engine', 'pending_nys_50_t_tables', 'employee_withholding_required', true),
    'unemployment', jsonb_build_object('agency_code', 'NY_DOL', 'form', 'NYS-45', 'wage_base', 17600, 'new_employer_total_rate', 0.041, 'new_employer_normal_rate', 0.034, 'rsf_rate', 0.00075, 'min_total_rate', 0.017, 'max_total_rate', 0.095)
  ),
  'New York Tax/DOL withholding and unemployment',
  'https://dol.ny.gov/node/91',
  date '2026-05-29'
),
(
  2026,
  'NYC',
  'local',
  'NY',
  'New York City',
  jsonb_build_object(
    'local_income_tax', jsonb_build_object('engine', 'pending_nyc_50_t_tables', 'employee_withholding_required', true)
  ),
  'New York City Withholding Tax Tables and Methods',
  'https://www.tax.ny.gov/bus/wt/amount_deduct.htm',
  date '2026-05-29'
)
on conflict (tax_year, jurisdiction_code) do update set
  jurisdiction_type = excluded.jurisdiction_type,
  state_code = excluded.state_code,
  locality = excluded.locality,
  taxes = excluded.taxes,
  source_label = excluded.source_label,
  source_url = excluded.source_url,
  source_retrieved_on = excluded.source_retrieved_on,
  active = true,
  updated_at = now();

alter table public.payroll_run_lines
  add column if not exists federal_income_tax numeric not null default 0,
  add column if not exists state_income_tax numeric not null default 0,
  add column if not exists local_income_tax numeric not null default 0,
  add column if not exists employee_tax_total numeric not null default 0,
  add column if not exists net_pay numeric,
  add column if not exists ss_employer numeric not null default 0,
  add column if not exists medicare_employer numeric not null default 0,
  add column if not exists fica_employer_total numeric not null default 0,
  add column if not exists futa_taxable_this_run numeric not null default 0,
  add column if not exists futa_employer numeric not null default 0,
  add column if not exists suta_state text,
  add column if not exists suta_taxable_this_run numeric not null default 0,
  add column if not exists suta_employer numeric not null default 0,
  add column if not exists employer_tax_total numeric not null default 0,
  add column if not exists total_tax_liability numeric not null default 0,
  add column if not exists tax_details jsonb not null default '{}'::jsonb,
  add column if not exists tax_applied_at timestamptz;

create table if not exists public.payroll_tax_liabilities (
  id uuid primary key default gen_random_uuid(),
  payroll_run_id uuid not null references public.payroll_runs(id) on delete cascade,
  pay_period_id uuid not null references public.pay_periods(id) on delete cascade,
  employee_id uuid references public.employees(id) on delete set null,
  payroll_run_line_id uuid references public.payroll_run_lines(id) on delete cascade,
  agency_code text not null,
  jurisdiction_code text not null,
  tax_type text not null,
  employee_amount numeric not null default 0,
  employer_amount numeric not null default 0,
  taxable_wages numeric not null default 0,
  wage_base_remaining numeric,
  due_date date,
  deposit_status text not null default 'pending'
    check (deposit_status in ('draft','pending','scheduled','paid','waived','void')),
  confirmation text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (employee_amount >= 0),
  check (employer_amount >= 0),
  check (taxable_wages >= 0)
);

alter table public.payroll_tax_liabilities enable row level security;

drop policy if exists payroll_tax_liabilities_admin_all on public.payroll_tax_liabilities;
create policy payroll_tax_liabilities_admin_all
  on public.payroll_tax_liabilities
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create index if not exists payroll_tax_liabilities_run_idx
  on public.payroll_tax_liabilities (payroll_run_id, agency_code, tax_type);

create index if not exists payroll_tax_liabilities_due_idx
  on public.payroll_tax_liabilities (due_date, deposit_status);

create table if not exists public.payroll_tax_audits (
  id uuid primary key default gen_random_uuid(),
  payroll_run_id uuid references public.payroll_runs(id) on delete set null,
  payroll_run_line_id uuid references public.payroll_run_lines(id) on delete set null,
  employee_id uuid references public.employees(id) on delete set null,
  action text not null,
  actor_user_id uuid not null default auth.uid(),
  reason text,
  old_value jsonb not null default '{}'::jsonb,
  new_value jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.payroll_tax_audits enable row level security;

drop policy if exists payroll_tax_audits_admin_select on public.payroll_tax_audits;
create policy payroll_tax_audits_admin_select
  on public.payroll_tax_audits
  for select
  to authenticated
  using (public.is_admin());

create index if not exists payroll_tax_audits_run_idx
  on public.payroll_tax_audits (payroll_run_id, created_at desc);

grant select, insert, update, delete on public.employer_profiles to authenticated;
grant select, insert, update, delete on public.employer_state_tax_accounts to authenticated;
grant select, insert, update, delete on public.employee_sensitive_tax_ids to authenticated;
grant select, insert, update, delete on public.employee_federal_withholding_elections to authenticated;
grant select, insert, update, delete on public.employee_state_withholding_elections to authenticated;
grant select, insert, update, delete on public.employee_employment_compliance to authenticated;
grant select on public.payroll_tax_jurisdictions to authenticated;
grant select, insert, update, delete on public.payroll_tax_liabilities to authenticated;
grant select on public.payroll_tax_audits to authenticated;

grant select, insert, update, delete on public.employer_profiles to service_role;
grant select, insert, update, delete on public.employer_state_tax_accounts to service_role;
grant select, insert, update, delete on public.employee_sensitive_tax_ids to service_role;
grant select, insert, update, delete on public.employee_federal_withholding_elections to service_role;
grant select, insert, update, delete on public.employee_state_withholding_elections to service_role;
grant select, insert, update, delete on public.employee_employment_compliance to service_role;
grant select, insert, update, delete on public.payroll_tax_jurisdictions to service_role;
grant select, insert, update, delete on public.payroll_tax_liabilities to service_role;
grant select, insert, update, delete on public.payroll_tax_audits to service_role;

create or replace function public.payroll_quarter_due_date(_period_end date)
returns date
language sql
immutable
as $function$
  select (date_trunc('quarter', _period_end::timestamp) + interval '4 months' - interval '1 day')::date;
$function$;

create or replace function public.payroll_pay_periods_per_year(_start_date date, _end_date date, _default_frequency text default 'biweekly')
returns int
language plpgsql
immutable
as $function$
declare
  v_days int := greatest(1, (_end_date - _start_date) + 1);
  v_freq text := lower(coalesce(_default_frequency, 'biweekly'));
begin
  if v_freq = 'weekly' then
    return 52;
  elsif v_freq = 'semimonthly' then
    return 24;
  elsif v_freq = 'monthly' then
    return 12;
  elsif v_days between 13 and 15 then
    return 26;
  elsif v_days between 6 and 8 then
    return 52;
  elsif v_days between 27 and 32 then
    return 12;
  end if;

  return 26;
end;
$function$;

create or replace function public.payroll_2026_federal_annual_withholding(
  _adjusted_annual_wage numeric,
  _filing_status text,
  _step2_checkbox boolean default false
)
returns numeric
language sql
stable
as $function$
  with input as (
    select
      greatest(coalesce(_adjusted_annual_wage, 0), 0)::numeric as wage,
      case
        when _filing_status = 'married_filing_jointly' then 'married_filing_jointly'
        when _filing_status = 'head_of_household' then 'head_of_household'
        else 'single_or_married_filing_separately'
      end as filing_status,
      coalesce(_step2_checkbox, false) as step2_checkbox
  ),
  brackets(filing_status, step2_checkbox, low, high, base_tax, rate, excess_over) as (
    values
      ('married_filing_jointly', false, 0::numeric, 19300::numeric, 0::numeric, 0::numeric, 0::numeric),
      ('married_filing_jointly', false, 19300, 44100, 0, 0.10, 19300),
      ('married_filing_jointly', false, 44100, 120100, 2480, 0.12, 44100),
      ('married_filing_jointly', false, 120100, 230700, 11600, 0.22, 120100),
      ('married_filing_jointly', false, 230700, 422850, 35932, 0.24, 230700),
      ('married_filing_jointly', false, 422850, 531750, 82048, 0.32, 422850),
      ('married_filing_jointly', false, 531750, 788000, 116896, 0.35, 531750),
      ('married_filing_jointly', false, 788000, null, 206583.50, 0.37, 788000),
      ('single_or_married_filing_separately', false, 0, 7500, 0, 0, 0),
      ('single_or_married_filing_separately', false, 7500, 19900, 0, 0.10, 7500),
      ('single_or_married_filing_separately', false, 19900, 57900, 1240, 0.12, 19900),
      ('single_or_married_filing_separately', false, 57900, 113200, 5800, 0.22, 57900),
      ('single_or_married_filing_separately', false, 113200, 209275, 17966, 0.24, 113200),
      ('single_or_married_filing_separately', false, 209275, 263725, 41024, 0.32, 209275),
      ('single_or_married_filing_separately', false, 263725, 648100, 58448, 0.35, 263725),
      ('single_or_married_filing_separately', false, 648100, null, 192979.25, 0.37, 648100),
      ('head_of_household', false, 0, 15550, 0, 0, 0),
      ('head_of_household', false, 15550, 33250, 0, 0.10, 15550),
      ('head_of_household', false, 33250, 83000, 1770, 0.12, 33250),
      ('head_of_household', false, 83000, 121250, 7740, 0.22, 83000),
      ('head_of_household', false, 121250, 217300, 16155, 0.24, 121250),
      ('head_of_household', false, 217300, 271750, 39207, 0.32, 217300),
      ('head_of_household', false, 271750, 656150, 56631, 0.35, 271750),
      ('head_of_household', false, 656150, null, 191171, 0.37, 656150),
      ('married_filing_jointly', true, 0, 16100, 0, 0, 0),
      ('married_filing_jointly', true, 16100, 28500, 0, 0.10, 16100),
      ('married_filing_jointly', true, 28500, 66500, 1240, 0.12, 28500),
      ('married_filing_jointly', true, 66500, 121800, 5800, 0.22, 66500),
      ('married_filing_jointly', true, 121800, 217875, 17966, 0.24, 121800),
      ('married_filing_jointly', true, 217875, 272325, 41024, 0.32, 217875),
      ('married_filing_jointly', true, 272325, 400450, 58448, 0.35, 272325),
      ('married_filing_jointly', true, 400450, null, 103291.75, 0.37, 400450),
      ('single_or_married_filing_separately', true, 0, 8050, 0, 0, 0),
      ('single_or_married_filing_separately', true, 8050, 14250, 0, 0.10, 8050),
      ('single_or_married_filing_separately', true, 14250, 33250, 620, 0.12, 14250),
      ('single_or_married_filing_separately', true, 33250, 60900, 2900, 0.22, 33250),
      ('single_or_married_filing_separately', true, 60900, 108938, 8983, 0.24, 60900),
      ('single_or_married_filing_separately', true, 108938, 136163, 20512, 0.32, 108938),
      ('single_or_married_filing_separately', true, 136163, 328350, 29224, 0.35, 136163),
      ('single_or_married_filing_separately', true, 328350, null, 96489.63, 0.37, 328350),
      ('head_of_household', true, 0, 12075, 0, 0, 0),
      ('head_of_household', true, 12075, 20925, 0, 0.10, 12075),
      ('head_of_household', true, 20925, 45800, 885, 0.12, 20925),
      ('head_of_household', true, 45800, 64925, 3870, 0.22, 45800),
      ('head_of_household', true, 64925, 112950, 8077.50, 0.24, 64925),
      ('head_of_household', true, 112950, 140175, 19603.50, 0.32, 112950),
      ('head_of_household', true, 140175, 332375, 28315.50, 0.35, 140175),
      ('head_of_household', true, 332375, null, 95585.50, 0.37, 332375)
  )
  select round((b.base_tax + greatest(0, i.wage - b.excess_over) * b.rate)::numeric, 6)
  from input i
  join brackets b
    on b.filing_status = i.filing_status
   and b.step2_checkbox = i.step2_checkbox
   and i.wage >= b.low
   and (b.high is null or i.wage < b.high)
  limit 1;
$function$;

create or replace function public.payroll_calculate_federal_withholding_2026(
  _gross_pay numeric,
  _pay_periods_per_year int,
  _filing_status text,
  _multiple_jobs_step2 boolean,
  _step3_credits numeric,
  _step4a_other_income numeric,
  _step4b_deductions numeric,
  _step4c_extra_withholding numeric,
  _exempt_federal boolean
)
returns jsonb
language plpgsql
stable
as $function$
declare
  v_periods int := greatest(coalesce(_pay_periods_per_year, 26), 1);
  v_gross numeric := greatest(coalesce(_gross_pay, 0), 0);
  v_filing_status text := case
    when _filing_status = 'married_filing_jointly' then 'married_filing_jointly'
    when _filing_status = 'head_of_household' then 'head_of_household'
    else 'single_or_married_filing_separately'
  end;
  v_step2 boolean := coalesce(_multiple_jobs_step2, false);
  v_standard_adjustment numeric;
  v_annual_wage numeric;
  v_adjusted_annual_wage numeric;
  v_tentative_annual numeric;
  v_tentative_period numeric;
  v_credit_period numeric;
  v_withholding numeric;
begin
  if coalesce(_exempt_federal, false) then
    return jsonb_build_object(
      'amount', 0,
      'status', 'exempt',
      'method', 'irs_pub_15t_2026_percentage_method',
      'pay_periods_per_year', v_periods
    );
  end if;

  v_standard_adjustment := case
    when v_step2 then 0
    when v_filing_status = 'married_filing_jointly' then 12900
    else 8600
  end;
  v_annual_wage := v_gross * v_periods;
  v_adjusted_annual_wage := greatest(
    0,
    v_annual_wage
      + greatest(coalesce(_step4a_other_income, 0), 0)
      - (greatest(coalesce(_step4b_deductions, 0), 0) + v_standard_adjustment)
  );
  v_tentative_annual := coalesce(
    public.payroll_2026_federal_annual_withholding(v_adjusted_annual_wage, v_filing_status, v_step2),
    0
  );
  v_tentative_period := v_tentative_annual / v_periods;
  v_credit_period := greatest(coalesce(_step3_credits, 0), 0) / v_periods;
  v_withholding := round(
    (
      greatest(0, v_tentative_period - v_credit_period)
      + greatest(coalesce(_step4c_extra_withholding, 0), 0)
    )::numeric,
    2
  );

  return jsonb_build_object(
    'amount', v_withholding,
    'status', 'calculated',
    'method', 'irs_pub_15t_2026_percentage_method',
    'filing_status', v_filing_status,
    'multiple_jobs_step2', v_step2,
    'pay_periods_per_year', v_periods,
    'annualized_wages', round(v_annual_wage, 2),
    'standard_adjustment', v_standard_adjustment,
    'adjusted_annual_wage', round(v_adjusted_annual_wage, 2),
    'tentative_annual_withholding', round(v_tentative_annual, 2),
    'tentative_period_withholding', round(v_tentative_period, 2),
    'credit_per_period', round(v_credit_period, 2),
    'extra_withholding_per_period', round(greatest(coalesce(_step4c_extra_withholding, 0), 0), 2),
    'source_url', 'https://www.irs.gov/publications/p15t',
    'source_retrieved_on', '2026-05-29'
  );
end;
$function$;

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
     where nullif(btrim(coalesce(s.state, '')), '') is null
        or nullif(btrim(coalesce(s.city, '')), '') is null
        or nullif(btrim(coalesce(s.postal_code, '')), '') is null),
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

create or replace function public.payroll_operational_readiness(_period_id uuid)
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
  v_tax jsonb;
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

  v_tax := public.payroll_required_tax_profile_blockers(_period_id, false);

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
    'tax_readiness', v_tax,
    'missing_work_location_tax_addresses', coalesce((v_tax->>'missing_work_location_tax_addresses')::int, 0),
    'pending_state_withholding_engine', coalesce((v_tax->>'pending_state_withholding_engine')::int, 0),
    'ready', (
      v_open_shifts = 0
      and v_open_breaks = 0
      and v_pending_approval = 0
      and v_unwaived_anomalies = 0
      and v_missing_rates = 0
      and coalesce((v_tax->>'ready')::boolean, false)
    )
  );
end;
$function$;

drop function if exists public.payroll_period_readiness_core(uuid);
create or replace function public.payroll_period_readiness_core(_period_id uuid)
returns jsonb
language sql
security definer
set search_path = public
as $function$
  select public.payroll_operational_readiness(_period_id);
$function$;

create or replace function public.payroll_period_readiness(_period_id uuid)
returns jsonb
language sql
security definer
set search_path = public
as $function$
  select public.payroll_operational_readiness(_period_id);
$function$;

create or replace function public.apply_fica_deductions_to_run(_run_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_run public.payroll_runs;
  v_period public.pay_periods;
  v_year int;
  v_periods int;
  v_constants public.payroll_tax_constants%rowtype;
  r record;
  v_prior_wages numeric;
  v_prior_state_wages numeric;
  v_ss_taxable numeric;
  v_medicare_taxable numeric;
  v_addl_medicare_taxable numeric;
  v_ss_employee numeric;
  v_medicare_employee numeric;
  v_addl_medicare_employee numeric;
  v_fica_employee_total numeric;
  v_ss_employer numeric;
  v_medicare_employer numeric;
  v_fica_employer_total numeric;
  v_fed jsonb;
  v_federal_income_tax numeric;
  v_state_income_tax numeric;
  v_local_income_tax numeric;
  v_employee_tax_total numeric;
  v_net_pay numeric;
  v_futa_taxable numeric;
  v_futa_employer numeric;
  v_suta_state text;
  v_suta_taxable numeric;
  v_suta_employer numeric;
  v_suta_rate numeric;
  v_suta_wage_base numeric;
  v_suta_agency text;
  v_suta_status text;
  v_employer_tax_total numeric;
  v_total_tax_liability numeric;
  v_store_state text;
  v_employee_state text;
  v_jur jsonb;
  v_state_engine text;
  v_line_old jsonb;
  v_line_new jsonb;
begin
  if not public.is_admin() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  select * into v_run
  from public.payroll_runs
  where id = _run_id;

  if v_run.id is null then
    raise exception 'apply_fica_deductions_to_run: run not found (%)', _run_id;
  end if;

  select * into v_period
  from public.pay_periods
  where id = v_run.pay_period_id;

  v_year := extract(year from v_period.end_date)::int;
  v_periods := public.payroll_pay_periods_per_year(v_period.start_date, v_period.end_date, null);

  select * into v_constants
  from public.payroll_tax_constants
  where tax_year = v_year;

  if v_constants.tax_year is null then
    select
      v_year,
      case when v_year = 2026 then 184500 else 184500 end,
      200000,
      0.062,
      0.062,
      0.0145,
      0.0145,
      0.009,
      7000,
      0.06,
      0.054,
      0.006,
      'fallback',
      current_date
    into
      v_constants.tax_year,
      v_constants.ss_wage_base,
      v_constants.addl_medicare_threshold,
      v_constants.ss_employee_rate,
      v_constants.ss_employer_rate,
      v_constants.medicare_employee_rate,
      v_constants.medicare_employer_rate,
      v_constants.addl_medicare_employee_rate,
      v_constants.futa_wage_base,
      v_constants.futa_gross_rate,
      v_constants.futa_standard_credit,
      v_constants.futa_net_rate,
      v_constants.source_url,
      v_constants.source_retrieved_on;
  end if;

  delete from public.payroll_tax_liabilities
  where payroll_run_id = _run_id
    and deposit_status <> 'paid';

  for r in
    select
      l.*,
      e.worker_type,
      e.role,
      e.display_name,
      fw.filing_status,
      fw.multiple_jobs_step2,
      fw.step3_credits,
      fw.step4a_other_income,
      fw.step4b_deductions,
      fw.step4c_extra_withholding,
      fw.exempt_federal,
      fw.id as federal_w4_id
    from public.payroll_run_lines l
    join public.employees e on e.id = l.employee_id
    left join lateral (
      select *
      from public.employee_federal_withholding_elections w4
      where w4.employee_id = l.employee_id
        and w4.status = 'active'
        and w4.effective_from <= v_period.end_date
        and (w4.effective_to is null or w4.effective_to >= v_period.start_date)
      order by w4.effective_from desc, w4.created_at desc
      limit 1
    ) fw on true
    where l.payroll_run_id = _run_id
  loop
    select coalesce(sum(l2.gross_pay), 0)::numeric into v_prior_wages
    from public.payroll_run_lines l2
    join public.payroll_runs r2 on r2.id = l2.payroll_run_id
    join public.pay_periods pp2 on pp2.id = r2.pay_period_id
    where l2.employee_id = r.employee_id
      and r2.status = 'final'
      and extract(year from pp2.end_date)::int = v_year
      and pp2.end_date < v_period.end_date;

    v_ss_taxable := greatest(0, least(coalesce(r.gross_pay, 0), v_constants.ss_wage_base - coalesce(v_prior_wages, 0)));
    v_medicare_taxable := greatest(coalesce(r.gross_pay, 0), 0);
    v_addl_medicare_taxable := greatest(
      0,
      greatest(0, coalesce(v_prior_wages, 0) + coalesce(r.gross_pay, 0) - v_constants.addl_medicare_threshold)
      - greatest(0, coalesce(v_prior_wages, 0) - v_constants.addl_medicare_threshold)
    );

    if lower(coalesce(r.worker_type, 'employee')) = 'employee' then
      v_ss_employee := round(v_ss_taxable * v_constants.ss_employee_rate, 2);
      v_medicare_employee := round(v_medicare_taxable * v_constants.medicare_employee_rate, 2);
      v_addl_medicare_employee := round(v_addl_medicare_taxable * v_constants.addl_medicare_employee_rate, 2);
      v_fica_employee_total := round(v_ss_employee + v_medicare_employee + v_addl_medicare_employee, 2);
      v_ss_employer := round(v_ss_taxable * v_constants.ss_employer_rate, 2);
      v_medicare_employer := round(v_medicare_taxable * v_constants.medicare_employer_rate, 2);
      v_fica_employer_total := round(v_ss_employer + v_medicare_employer, 2);

      v_fed := public.payroll_calculate_federal_withholding_2026(
        r.gross_pay,
        v_periods,
        coalesce(r.filing_status, 'single_or_married_filing_separately'),
        coalesce(r.multiple_jobs_step2, false),
        coalesce(r.step3_credits, 0),
        coalesce(r.step4a_other_income, 0),
        coalesce(r.step4b_deductions, 0),
        coalesce(r.step4c_extra_withholding, 0),
        coalesce(r.exempt_federal, false)
      );
      v_federal_income_tax := coalesce((v_fed->>'amount')::numeric, 0);
    else
      v_ss_employee := 0;
      v_medicare_employee := 0;
      v_addl_medicare_employee := 0;
      v_fica_employee_total := 0;
      v_ss_employer := 0;
      v_medicare_employer := 0;
      v_fica_employer_total := 0;
      v_fed := jsonb_build_object('amount', 0, 'status', 'not_employee');
      v_federal_income_tax := 0;
    end if;

    select
      upper(coalesce(nullif(s.unemployment_state, ''), nullif(s.withholding_state, ''), nullif(s.state, '')))
    into v_store_state
    from public.store_locations s
    where s.id = (
      select nullif(seg->>'store_id', '')::uuid
      from jsonb_array_elements(coalesce(r.details->'shift_breakdown', '[]'::jsonb)) seg
      where nullif(seg->>'store_id', '') is not null
      limit 1
    );

    select upper(nullif(a.state, '')) into v_employee_state
    from public.employee_legal_addresses a
    where a.employee_id = r.employee_id
      and a.is_current is true
    order by a.created_at desc
    limit 1;

    v_suta_state := coalesce(v_store_state, v_employee_state, 'FL');

    select j.taxes into v_jur
    from public.payroll_tax_jurisdictions j
    where j.tax_year = v_year
      and j.jurisdiction_code = v_suta_state
      and j.active is true;

    v_state_engine := coalesce(v_jur#>>'{state_income_tax,engine}', 'none');
    if lower(coalesce(r.worker_type, 'employee')) <> 'employee' then
      v_state_income_tax := 0;
      v_local_income_tax := 0;
    elsif v_suta_state = 'FL' then
      v_state_income_tax := 0;
      v_local_income_tax := 0;
    elsif v_state_engine = 'none' then
      v_state_income_tax := 0;
      v_local_income_tax := 0;
    else
      v_state_income_tax := 0;
      v_local_income_tax := 0;
    end if;

    v_suta_rate := null;
    v_suta_wage_base := null;
    v_suta_agency := coalesce(v_jur#>>'{unemployment,agency_code}', v_suta_state || '_UI');
    v_suta_status := 'not_employee';

    if lower(coalesce(r.worker_type, 'employee')) = 'employee' then
      select a.suta_rate, a.suta_wage_base
      into v_suta_rate, v_suta_wage_base
      from public.employer_state_tax_accounts a
      where a.state_code = v_suta_state
        and a.active is true
        and a.effective_from <= v_period.end_date
        and (a.effective_to is null or a.effective_to >= v_period.start_date)
      order by a.effective_from desc, a.created_at desc
      limit 1;

      if v_suta_rate is null then
        v_suta_rate := coalesce(
          nullif(v_jur#>>'{unemployment,new_employer_total_rate}', '')::numeric,
          nullif(v_jur#>>'{unemployment,new_employer_rate}', '')::numeric,
          0
        );
        v_suta_status := 'estimated_new_employer_rate';
      else
        v_suta_status := 'employer_assigned_rate';
      end if;

      v_suta_wage_base := coalesce(
        v_suta_wage_base,
        nullif(v_jur#>>'{unemployment,wage_base}', '')::numeric,
        0
      );

      select coalesce(sum(l2.gross_pay), 0)::numeric into v_prior_state_wages
      from public.payroll_run_lines l2
      join public.payroll_runs r2 on r2.id = l2.payroll_run_id
      join public.pay_periods pp2 on pp2.id = r2.pay_period_id
      where l2.employee_id = r.employee_id
        and r2.status = 'final'
        and extract(year from pp2.end_date)::int = v_year
        and pp2.end_date < v_period.end_date
        and coalesce(l2.suta_state, l2.tax_details->>'work_state', v_suta_state) = v_suta_state;

      v_suta_taxable := greatest(0, least(coalesce(r.gross_pay, 0), v_suta_wage_base - coalesce(v_prior_state_wages, 0)));
      v_suta_employer := round(v_suta_taxable * coalesce(v_suta_rate, 0), 2);
    else
      v_suta_taxable := 0;
      v_suta_employer := 0;
    end if;

    if lower(coalesce(r.worker_type, 'employee')) = 'employee' then
      v_futa_taxable := greatest(0, least(coalesce(r.gross_pay, 0), v_constants.futa_wage_base - coalesce(v_prior_wages, 0)));
      v_futa_employer := round(v_futa_taxable * v_constants.futa_net_rate, 2);
    else
      v_futa_taxable := 0;
      v_futa_employer := 0;
    end if;

    v_employee_tax_total := round(
      coalesce(v_federal_income_tax, 0)
      + coalesce(v_state_income_tax, 0)
      + coalesce(v_local_income_tax, 0)
      + coalesce(v_fica_employee_total, 0),
      2
    );
    v_net_pay := round(greatest(0, coalesce(r.gross_pay, 0) - v_employee_tax_total), 2);
    v_employer_tax_total := round(coalesce(v_fica_employer_total, 0) + coalesce(v_futa_employer, 0) + coalesce(v_suta_employer, 0), 2);
    v_total_tax_liability := round(v_employee_tax_total + v_employer_tax_total, 2);

    v_line_old := jsonb_build_object(
      'federal_income_tax', r.federal_income_tax,
      'state_income_tax', r.state_income_tax,
      'local_income_tax', r.local_income_tax,
      'employee_tax_total', r.employee_tax_total,
      'net_pay', r.net_pay,
      'employer_tax_total', r.employer_tax_total
    );

    update public.payroll_run_lines l
    set
      fica_year = v_year,
      ytd_wages = coalesce(v_prior_wages, 0),
      ss_taxable_this_run = v_ss_taxable,
      ss_employee = v_ss_employee,
      medicare_employee = v_medicare_employee,
      addl_medicare_employee = v_addl_medicare_employee,
      fica_employee_total = v_fica_employee_total,
      net_pre_fed = round(coalesce(r.gross_pay, 0) - v_fica_employee_total, 2),
      fica_params = jsonb_build_object(
        'ss_wage_base', v_constants.ss_wage_base,
        'addl_medicare_threshold', v_constants.addl_medicare_threshold,
        'rates', jsonb_build_object(
          'ss_employee', v_constants.ss_employee_rate,
          'ss_employer', v_constants.ss_employer_rate,
          'medicare_employee', v_constants.medicare_employee_rate,
          'medicare_employer', v_constants.medicare_employer_rate,
          'addl_medicare_employee', v_constants.addl_medicare_employee_rate
        ),
        'source_url', v_constants.source_url,
        'source_retrieved_on', v_constants.source_retrieved_on
      ),
      federal_income_tax = v_federal_income_tax,
      state_income_tax = v_state_income_tax,
      local_income_tax = v_local_income_tax,
      employee_tax_total = v_employee_tax_total,
      net_pay = v_net_pay,
      ss_employer = v_ss_employer,
      medicare_employer = v_medicare_employer,
      fica_employer_total = v_fica_employer_total,
      futa_taxable_this_run = v_futa_taxable,
      futa_employer = v_futa_employer,
      suta_state = v_suta_state,
      suta_taxable_this_run = v_suta_taxable,
      suta_employer = v_suta_employer,
      employer_tax_total = v_employer_tax_total,
      total_tax_liability = v_total_tax_liability,
      tax_details = jsonb_build_object(
        'tax_year', v_year,
        'work_state', v_suta_state,
        'federal_withholding', v_fed || jsonb_build_object(
          'w4_election_id', r.federal_w4_id,
          'default_w4_used', r.federal_w4_id is null
        ),
        'state_withholding', jsonb_build_object(
          'state', v_suta_state,
          'amount', v_state_income_tax,
          'engine', v_state_engine,
          'status', case
            when v_suta_state = 'FL' then 'not_required'
            when v_state_engine = 'none' then 'not_required'
            else 'calculation_pending'
          end
        ),
        'local_withholding', jsonb_build_object(
          'amount', v_local_income_tax,
          'status', case when v_suta_state = 'NY' then 'check_nyc_or_yonkers_residency' else 'not_required' end
        ),
        'futa', jsonb_build_object(
          'taxable_wages', v_futa_taxable,
          'amount', v_futa_employer,
          'net_rate', v_constants.futa_net_rate,
          'wage_base', v_constants.futa_wage_base,
          'deposit_threshold', 500
        ),
        'suta', jsonb_build_object(
          'state', v_suta_state,
          'agency_code', v_suta_agency,
          'taxable_wages', v_suta_taxable,
          'amount', v_suta_employer,
          'rate', v_suta_rate,
          'wage_base', v_suta_wage_base,
          'status', v_suta_status
        ),
        'employer_tax_total', v_employer_tax_total,
        'employee_tax_total', v_employee_tax_total,
        'net_pay', v_net_pay,
        'calculated_at', now()
      ),
      details = coalesce(l.details, '{}'::jsonb) || jsonb_build_object(
        'tax_calculation', jsonb_build_object(
          'employee_tax_total', v_employee_tax_total,
          'employer_tax_total', v_employer_tax_total,
          'net_pay', v_net_pay,
          'work_state', v_suta_state
        )
      ),
      tax_applied_at = now()
    where l.id = r.id
    returning jsonb_build_object(
      'federal_income_tax', federal_income_tax,
      'state_income_tax', state_income_tax,
      'local_income_tax', local_income_tax,
      'employee_tax_total', employee_tax_total,
      'net_pay', net_pay,
      'employer_tax_total', employer_tax_total
    )
    into v_line_new;

    insert into public.payroll_tax_audits (
      payroll_run_id,
      payroll_run_line_id,
      employee_id,
      action,
      actor_user_id,
      reason,
      old_value,
      new_value
    ) values (
      _run_id,
      r.id,
      r.employee_id,
      'calculate_payroll_taxes',
      auth.uid(),
      'Payroll tax calculation applied',
      v_line_old,
      v_line_new
    );

    if lower(coalesce(r.worker_type, 'employee')) = 'employee' then
      insert into public.payroll_tax_liabilities (
        payroll_run_id,
        pay_period_id,
        employee_id,
        payroll_run_line_id,
        agency_code,
        jurisdiction_code,
        tax_type,
        employee_amount,
        employer_amount,
        taxable_wages,
        wage_base_remaining,
        due_date,
        details
      ) values
      (
        _run_id,
        v_run.pay_period_id,
        r.employee_id,
        r.id,
        'IRS',
        'FED',
        'federal_income_tax',
        v_federal_income_tax,
        0,
        coalesce(r.gross_pay, 0),
        null,
        public.payroll_quarter_due_date(v_period.end_date),
        v_fed
      ),
      (
        _run_id,
        v_run.pay_period_id,
        r.employee_id,
        r.id,
        'IRS',
        'FED',
        'social_security',
        v_ss_employee,
        v_ss_employer,
        v_ss_taxable,
        greatest(0, v_constants.ss_wage_base - coalesce(v_prior_wages, 0) - v_ss_taxable),
        public.payroll_quarter_due_date(v_period.end_date),
        jsonb_build_object('rate_employee', v_constants.ss_employee_rate, 'rate_employer', v_constants.ss_employer_rate)
      ),
      (
        _run_id,
        v_run.pay_period_id,
        r.employee_id,
        r.id,
        'IRS',
        'FED',
        'medicare',
        v_medicare_employee + v_addl_medicare_employee,
        v_medicare_employer,
        v_medicare_taxable,
        null,
        public.payroll_quarter_due_date(v_period.end_date),
        jsonb_build_object('rate_employee', v_constants.medicare_employee_rate, 'rate_employer', v_constants.medicare_employer_rate, 'additional_employee_amount', v_addl_medicare_employee)
      ),
      (
        _run_id,
        v_run.pay_period_id,
        r.employee_id,
        r.id,
        'IRS',
        'FED',
        'futa',
        0,
        v_futa_employer,
        v_futa_taxable,
        greatest(0, v_constants.futa_wage_base - coalesce(v_prior_wages, 0) - v_futa_taxable),
        public.payroll_quarter_due_date(v_period.end_date),
        jsonb_build_object('net_rate', v_constants.futa_net_rate, 'gross_rate', v_constants.futa_gross_rate, 'standard_credit', v_constants.futa_standard_credit)
      ),
      (
        _run_id,
        v_run.pay_period_id,
        r.employee_id,
        r.id,
        v_suta_agency,
        v_suta_state,
        'suta',
        0,
        v_suta_employer,
        v_suta_taxable,
        greatest(0, coalesce(v_suta_wage_base, 0) - coalesce(v_prior_state_wages, 0) - v_suta_taxable),
        public.payroll_quarter_due_date(v_period.end_date),
        jsonb_build_object('rate', v_suta_rate, 'rate_status', v_suta_status, 'wage_base', v_suta_wage_base)
      );
    end if;
  end loop;
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
  v_employee public.employees;
  v_paid numeric := 0;
  v_payable numeric := 0;
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

  select * into v_employee
  from public.employees
  where id = _employee_id;

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

  v_payable := case
    when lower(coalesce(v_employee.worker_type, 'employee')) = 'employee' then
      coalesce(v_line.net_pay, v_line.net_pre_fed, v_line.gross_pay, 0)
    else
      coalesce(v_line.gross_pay, 0)
  end;
  v_due := greatest(0, v_payable - v_paid);

  if _amount > v_due + 0.009 then
    raise exception 'Payment exceeds remaining net due amount (%).', round(v_due, 2)
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
    to_jsonb(v_row) || jsonb_build_object('payable_amount', v_payable, 'pay_basis', case when lower(coalesce(v_employee.worker_type, 'employee')) = 'employee' then 'net_pay' else 'gross_pay' end)
  );

  perform public.generate_payroll_statements_for_run(_payroll_run_id);

  return v_row;
end;
$function$;

create or replace view public.v_payroll_tax_liability_summary as
select
  payroll_run_id,
  pay_period_id,
  agency_code,
  jurisdiction_code,
  tax_type,
  due_date,
  deposit_status,
  round(sum(employee_amount), 2) as employee_amount,
  round(sum(employer_amount), 2) as employer_amount,
  round(sum(employee_amount + employer_amount), 2) as total_amount,
  round(sum(taxable_wages), 2) as taxable_wages,
  count(*) as line_count
from public.payroll_tax_liabilities
where deposit_status <> 'void'
group by payroll_run_id, pay_period_id, agency_code, jurisdiction_code, tax_type, due_date, deposit_status;

grant select on public.v_payroll_tax_liability_summary to authenticated;
grant execute on function public.payroll_required_tax_profile_blockers(uuid, boolean) to authenticated;
grant execute on function public.payroll_calculate_federal_withholding_2026(numeric, int, text, boolean, numeric, numeric, numeric, numeric, boolean) to authenticated;
grant execute on function public.payroll_2026_federal_annual_withholding(numeric, text, boolean) to authenticated;
grant execute on function public.payroll_quarter_due_date(date) to authenticated;
grant execute on function public.payroll_pay_periods_per_year(date, date, text) to authenticated;
