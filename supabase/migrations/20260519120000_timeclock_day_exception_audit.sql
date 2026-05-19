alter table public.schedule_audit_log
  drop constraint if exists schedule_audit_log_schedule_table_check;

alter table public.schedule_audit_log
  add constraint schedule_audit_log_schedule_table_check
  check (schedule_table in ('work_schedules', 'work_schedule_overrides', 'timeclock_day_exceptions'));

drop trigger if exists trg_timeclock_day_exceptions_audit_log on public.timeclock_day_exceptions;
create trigger trg_timeclock_day_exceptions_audit_log
after insert or update or delete on public.timeclock_day_exceptions
for each row execute function public.log_work_schedule_change();
