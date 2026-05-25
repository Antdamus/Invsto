-- Employees may update progress or completion on assigned work, but only admins
-- can move task ownership to another user.

create or replace function public.prevent_non_admin_task_reassignment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.assigned_to_user_id is distinct from new.assigned_to_user_id
    and not public.is_admin()
  then
    raise exception 'Only admins can reassign tasks' using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_team_tasks_admin_only_reassignment on public.team_tasks;
create trigger trg_team_tasks_admin_only_reassignment
before update on public.team_tasks
for each row execute function public.prevent_non_admin_task_reassignment();

drop trigger if exists trg_ebay_order_tasks_admin_only_reassignment on public.ebay_order_tasks;
create trigger trg_ebay_order_tasks_admin_only_reassignment
before update on public.ebay_order_tasks
for each row execute function public.prevent_non_admin_task_reassignment();
