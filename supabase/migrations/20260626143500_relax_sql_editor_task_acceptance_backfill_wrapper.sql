-- Let Supabase SQL editor run the task acceptance backfill even when the
-- operator's email is not represented as an active admin employee row.

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
  v_admin_email text := nullif(btrim(coalesce(_admin_email, '')), '');
  v_admin_user_id uuid;
begin
  if not (
    session_user in ('postgres', 'supabase_admin', 'service_role')
    or current_setting('request.jwt.claim.role', true) = 'service_role'
    or nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role' = 'service_role'
  ) then
    raise exception 'Only SQL editor or service role can use this wrapper' using errcode = '42501';
  end if;

  if v_admin_email is null then
    raise exception 'Pass the operator email for the audit trail' using errcode = '22023';
  end if;

  select u.id
    into v_admin_user_id
  from auth.users u
  where lower(u.email) = lower(v_admin_email)
  order by u.created_at desc
  limit 1;

  perform set_config('request.jwt.claim.sub', coalesce(v_admin_user_id::text, ''), true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', coalesce(v_admin_user_id::text, ''),
      'email', v_admin_email,
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
