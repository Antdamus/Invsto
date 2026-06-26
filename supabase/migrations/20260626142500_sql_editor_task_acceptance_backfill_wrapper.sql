-- Supabase SQL editor does not carry the app user's JWT, so admin-only
-- maintenance functions that depend on auth.uid() need a privileged wrapper.

create or replace function public.backfill_task_acceptance_queue_as_admin(
  _admin_email text,
  _dry_run boolean default true,
  _since timestamptz default null,
  _limit integer default 500,
  _include_team_tasks boolean default true,
  _include_order_tasks boolean default true
)
returns table (
  task_source text,
  task_id uuid,
  old_status text,
  new_status text,
  title text,
  assigned_to_email text,
  reviewer_email text,
  reason text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_employee record;
begin
  if not (
    session_user in ('postgres', 'supabase_admin', 'service_role')
    or current_setting('request.jwt.claim.role', true) = 'service_role'
    or nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role' = 'service_role'
  ) then
    raise exception 'Only SQL editor or service role can use this wrapper' using errcode = '42501';
  end if;

  select e.user_id, e.email
    into v_employee
  from public.employees e
  where lower(e.email) = lower(nullif(btrim(coalesce(_admin_email, '')), ''))
    and e.active is true
    and lower(coalesce(e.role, '')) = 'admin'
  limit 1;

  if not found then
    raise exception 'Admin employee email not found or inactive: %', coalesce(_admin_email, '<empty>') using errcode = 'P0002';
  end if;

  perform set_config('request.jwt.claim.sub', v_employee.user_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', v_employee.user_id::text,
      'email', v_employee.email,
      'role', 'authenticated',
      'user_metadata', jsonb_build_object('role', 'admin')
    )::text,
    true
  );

  return query
  select *
  from public.backfill_task_acceptance_queue(
    _dry_run,
    _since,
    _limit,
    _include_team_tasks,
    _include_order_tasks
  );
end;
$$;

revoke all on function public.backfill_task_acceptance_queue_as_admin(text, boolean, timestamptz, integer, boolean, boolean) from public;
grant execute on function public.backfill_task_acceptance_queue_as_admin(text, boolean, timestamptz, integer, boolean, boolean) to authenticated;
grant execute on function public.backfill_task_acceptance_queue_as_admin(text, boolean, timestamptz, integer, boolean, boolean) to service_role;
