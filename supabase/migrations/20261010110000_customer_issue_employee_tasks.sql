begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

-- Imported case trackers support eBay alerts; they are not employee assignments.
-- assigned_by is set by the explicit staff assignment RPC, never by the importer
-- or the automatic reviewer routing. Keep older deliberately assigned work.
create or replace function public.customer_issue_is_employee_task(_task jsonb)
returns boolean language sql immutable security invoker set search_path='' as $$
 select lower(btrim(coalesce(_task#>>'{metadata,source}',''))) not in
  ('ebay_return_api','ebay_post_order_api','ebay_return_extension','customer_issue_action')
  or nullif(_task->>'assigned_by','') is not null
$$;
revoke all on function public.customer_issue_is_employee_task(jsonb) from public,anon;
grant execute on function public.customer_issue_is_employee_task(jsonb) to authenticated,service_role;

-- Filter before paging, and retain the underlying task/case row security.
create view public.employee_return_tasks with (security_invoker=true) as
 select t.* from public.ebay_return_tasks t
 where public.customer_issue_is_employee_task(to_jsonb(t));
revoke all on public.employee_return_tasks from public,anon;
grant select on public.employee_return_tasks to authenticated;
comment on view public.employee_return_tasks is
 'Staff-created or explicitly staff-assigned case work. Automatic case tracking remains in the underlying audit records.';

-- Explicit assignments notify staff, including adopted automatic records.
drop trigger trg_notify_ebay_return_task_assignment on public.ebay_return_tasks;
create trigger trg_notify_ebay_return_task_assignment after insert or update on public.ebay_return_tasks
 for each row when(public.customer_issue_is_employee_task(to_jsonb(new)))
 execute function public.notify_ebay_return_task_assignment();

-- Stop synthetic assignments and overdue-task reminders before email/SMS/in-app
-- delivery. Dedicated case arrival/action/deadline/outcome alerts still pass.
create function public.guard_automatic_case_task_notification()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.source='return' and new.notification_type not in ('customer_issue_action','customer_issue_deadline','customer_issue_sync')
  and exists(select 1 from public.ebay_return_tasks t where t.id=new.task_id
   and not public.customer_issue_is_employee_task(to_jsonb(t))) then return null; end if;
 return new;
end $$;
revoke all on function public.guard_automatic_case_task_notification() from public,anon,authenticated;
create trigger guard_automatic_case_task_notification before insert on public.task_notifications
 for each row execute function public.guard_automatic_case_task_notification();

notify pgrst,'reload schema';
commit;
