-- Require an explicit owner for tasks created from the eBay email triage flow.
create or replace function public.require_email_triage_task_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_metadata jsonb := coalesce(new.metadata, '{}'::jsonb);
begin
  if new.assigned_to_user_id is null
     and v_metadata ->> 'created_from' = 'email_triage'
     and v_metadata ? 'conversation_id' then
    raise exception 'Assign this task to someone before creating it.'
      using errcode = '22023';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_require_email_triage_team_task_owner on public.team_tasks;
create trigger trg_require_email_triage_team_task_owner
before insert on public.team_tasks
for each row
execute function public.require_email_triage_task_owner();

drop trigger if exists trg_require_email_triage_order_task_owner on public.ebay_order_tasks;
create trigger trg_require_email_triage_order_task_owner
before insert on public.ebay_order_tasks
for each row
execute function public.require_email_triage_task_owner();

comment on function public.require_email_triage_task_owner()
  is 'Rejects newly inserted eBay email-triage tasks without an assigned owner.';
