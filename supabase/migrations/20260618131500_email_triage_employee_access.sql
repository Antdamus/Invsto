-- Dedicated Email Triage access for selected employees.
-- New migration on purpose: Supabase will not replay edited prior migrations.

alter table public.employees
  add column if not exists email_triage_access boolean not null default false;

create table if not exists public.employee_app_access_audits (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  user_id uuid not null,
  app_key text not null,
  old_enabled boolean not null default false,
  new_enabled boolean not null default false,
  changed_by uuid,
  changed_by_email text,
  changed_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  constraint employee_app_access_audits_app_key_check
    check (app_key in ('email_triage'))
);

create index if not exists employee_app_access_audits_employee_idx
  on public.employee_app_access_audits(employee_id, changed_at desc);

create index if not exists employee_app_access_audits_user_idx
  on public.employee_app_access_audits(user_id, changed_at desc);

alter table public.employee_app_access_audits enable row level security;

revoke all on table public.employee_app_access_audits from public, anon, authenticated;
grant select on table public.employee_app_access_audits to authenticated;
grant select, insert on table public.employee_app_access_audits to service_role;

drop policy if exists "employee_app_access_audits_admin_select"
  on public.employee_app_access_audits;
create policy "employee_app_access_audits_admin_select"
on public.employee_app_access_audits
for select
to authenticated
using (
  exists (
    select 1
    from public.employees e
    where e.user_id = auth.uid()
      and e.active is distinct from false
      and e.role = 'admin'
  )
  or coalesce(auth.jwt() -> 'user_metadata' ->> 'role', '') = 'admin'
);

create or replace function public.can_access_email_triage()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.employees e
    where e.user_id = auth.uid()
      and e.active is distinct from false
      and (
        e.role = 'admin'
        or coalesce(e.email_triage_access, false) = true
      )
  )
  or coalesce(auth.jwt() -> 'user_metadata' ->> 'role', '') = 'admin';
$$;

revoke all on function public.can_access_email_triage() from public;
grant execute on function public.can_access_email_triage() to authenticated;

create or replace function public.admin_set_employee_email_triage_access(
  _user_id uuid,
  _enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_email text := auth.jwt() ->> 'email';
  v_employee record;
  v_old boolean;
  v_new boolean := coalesce(_enabled, false);
begin
  if _user_id is null then
    raise exception 'User id is required'
      using errcode = '22023';
  end if;

  if not (
    exists (
      select 1
      from public.employees e
      where e.user_id = v_actor
        and e.active is distinct from false
        and e.role = 'admin'
    )
    or coalesce(auth.jwt() -> 'user_metadata' ->> 'role', '') = 'admin'
  ) then
    raise exception 'Admin privileges are required to change Email Triage access'
      using errcode = '42501';
  end if;

  select e.id, e.user_id, e.email_triage_access
    into v_employee
  from public.employees e
  where e.user_id = _user_id
  limit 1;

  if not found then
    raise exception 'Employee user was not found'
      using errcode = 'P0002';
  end if;

  v_old := coalesce(v_employee.email_triage_access, false);

  update public.employees
  set email_triage_access = v_new
  where id = v_employee.id;

  if v_old is distinct from v_new then
    insert into public.employee_app_access_audits (
      employee_id,
      user_id,
      app_key,
      old_enabled,
      new_enabled,
      changed_by,
      changed_by_email,
      metadata
    )
    values (
      v_employee.id,
      v_employee.user_id,
      'email_triage',
      v_old,
      v_new,
      v_actor,
      v_actor_email,
      jsonb_build_object('source', 'admin_user_drawer')
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'user_id', v_employee.user_id,
    'employee_id', v_employee.id,
    'email_triage_access', v_new,
    'changed', v_old is distinct from v_new
  );
end;
$$;

revoke all on function public.admin_set_employee_email_triage_access(uuid, boolean) from public;
grant execute on function public.admin_set_employee_email_triage_access(uuid, boolean) to authenticated;

-- Direct Email Triage table access should use the dedicated permission.
drop policy if exists "ebay_seller_accounts_staff_select" on public.ebay_seller_accounts;
create policy "ebay_seller_accounts_staff_select"
on public.ebay_seller_accounts
for select
to authenticated
using (public.can_access_email_triage());

drop policy if exists "ebay_conversations_staff_select" on public.ebay_conversations;
create policy "ebay_conversations_staff_select"
on public.ebay_conversations
for select
to authenticated
using (public.can_access_email_triage());

drop policy if exists "ebay_conversation_messages_staff_select" on public.ebay_conversation_messages;
create policy "ebay_conversation_messages_staff_select"
on public.ebay_conversation_messages
for select
to authenticated
using (public.can_access_email_triage());

drop policy if exists "ebay_message_sync_runs_staff_select" on public.ebay_message_sync_runs;
create policy "ebay_message_sync_runs_staff_select"
on public.ebay_message_sync_runs
for select
to authenticated
using (public.can_access_email_triage());

drop policy if exists "ebay_conversation_links_staff_select" on public.ebay_conversation_links;
create policy "ebay_conversation_links_staff_select"
on public.ebay_conversation_links
for select
to authenticated
using (public.can_access_email_triage());

drop policy if exists "ebay_conversation_classifications_staff_select" on public.ebay_conversation_classifications;
create policy "ebay_conversation_classifications_staff_select"
on public.ebay_conversation_classifications
for select
to authenticated
using (public.can_access_email_triage());

drop policy if exists "ebay_conversation_classification_overrides_staff_select" on public.ebay_conversation_classification_overrides;
create policy "ebay_conversation_classification_overrides_staff_select"
on public.ebay_conversation_classification_overrides
for select
to authenticated
using (public.can_access_email_triage());

drop policy if exists "ebay_conversation_saved_views_staff_select" on public.ebay_conversation_saved_views;
create policy "ebay_conversation_saved_views_staff_select"
on public.ebay_conversation_saved_views
for select
to authenticated
using (public.can_access_email_triage());

drop policy if exists "ebay_conversation_saved_views_staff_insert" on public.ebay_conversation_saved_views;
create policy "ebay_conversation_saved_views_staff_insert"
on public.ebay_conversation_saved_views
for insert
to authenticated
with check (public.can_access_email_triage());

drop policy if exists "ebay_conversation_saved_views_staff_update" on public.ebay_conversation_saved_views;
create policy "ebay_conversation_saved_views_staff_update"
on public.ebay_conversation_saved_views
for update
to authenticated
using (public.can_access_email_triage())
with check (public.can_access_email_triage());

drop policy if exists "ebay_conversation_response_drafts_staff_select" on public.ebay_conversation_response_drafts;
create policy "ebay_conversation_response_drafts_staff_select"
on public.ebay_conversation_response_drafts
for select
to authenticated
using (public.can_access_email_triage());

drop policy if exists "ebay_message_approvals_staff_select" on public.ebay_message_approvals;
create policy "ebay_message_approvals_staff_select"
on public.ebay_message_approvals
for select
to authenticated
using (public.can_access_email_triage());

drop policy if exists "ebay_message_send_attempts_staff_select" on public.ebay_message_send_attempts;
create policy "ebay_message_send_attempts_staff_select"
on public.ebay_message_send_attempts
for select
to authenticated
using (public.can_access_email_triage());

drop policy if exists "ebay_message_activity_events_staff_select" on public.ebay_message_activity_events;
create policy "ebay_message_activity_events_staff_select"
on public.ebay_message_activity_events
for select
to authenticated
using (public.can_access_email_triage());

drop policy if exists "ebay_message_sync_checkpoints_staff_select" on public.ebay_message_sync_checkpoints;
create policy "ebay_message_sync_checkpoints_staff_select"
on public.ebay_message_sync_checkpoints
for select
to authenticated
using (public.can_access_email_triage());

drop policy if exists "ebay_conversation_classification_runs_staff_select" on public.ebay_conversation_classification_runs;
create policy "ebay_conversation_classification_runs_staff_select"
on public.ebay_conversation_classification_runs
for select
to authenticated
using (public.can_access_email_triage());

drop policy if exists "ebay_message_notifications_staff_select" on public.ebay_message_notifications;
create policy "ebay_message_notifications_staff_select"
on public.ebay_message_notifications
for select
to authenticated
using (public.can_access_email_triage());

-- Repoint the Email Triage security-definer RPC guards to the dedicated permission.
do $$
declare
  v_fn record;
  v_sql text;
  v_updated text;
begin
  for v_fn in
    select p.oid
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'get_ebay_canonical_mailbox',
        'get_ebay_canonical_mailbox_v2',
        'count_ebay_unclassified_conversations',
        'get_ebay_unclassified_conversation_queue',
        'create_ebay_conversation_message_task',
        'list_ebay_conversation_message_task_status',
        'mark_ebay_conversation_read',
        'mark_ebay_conversation_unread'
      )
  loop
    v_sql := pg_get_functiondef(v_fn.oid);
    v_updated := replace(v_sql, 'public.can_manage_inventory()', 'public.can_access_email_triage()');
    v_updated := replace(v_updated, 'if not public.is_admin() then', 'if not public.can_access_email_triage() then');

    if v_updated is distinct from v_sql then
      execute v_updated;
    end if;
  end loop;
end $$;

comment on column public.employees.email_triage_access
  is 'When true, active non-admin employees can open Email Triage from their dashboard.';

comment on function public.can_access_email_triage()
  is 'Returns true for active admins and active employees explicitly granted Email Triage access.';
