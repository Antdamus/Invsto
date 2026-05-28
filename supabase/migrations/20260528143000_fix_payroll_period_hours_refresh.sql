-- Make payroll-period materialized view refresh safe from admin shift edits.
-- Concurrent refresh requires a unique all-row index; older schemas only had
-- a non-unique pay_period_id index, which caused shift edits to fail.

create unique index if not exists mv_payroll_period_hours_unique
  on public.mv_payroll_period_hours (pay_period_id, employee_id);

create or replace function public.refresh_payroll_period_hours()
returns void
language plpgsql
security definer
set search_path = public
as $function$
begin
  begin
    refresh materialized view concurrently public.mv_payroll_period_hours;
  exception
    when feature_not_supported or object_not_in_prerequisite_state then
      refresh materialized view public.mv_payroll_period_hours;
  end;
end;
$function$;
