-- Dedicated access for the eBay Requests, Returns, and Disputes workbench.
-- This keeps post-order issue work grantable from Admin Users without making
-- the worker an admin or exposing every admin-only action.

alter table public.employees
  add column if not exists post_order_issue_access boolean not null default false;

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
  metadata jsonb not null default '{}'::jsonb
);

alter table public.employee_app_access_audits
  drop constraint if exists employee_app_access_audits_app_key_check;

alter table public.employee_app_access_audits
  add constraint employee_app_access_audits_app_key_check
    check (app_key in ('email_triage', 'post_order_issues'));

create or replace function public.can_access_post_order_issues()
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
        or coalesce(e.post_order_issue_access, false) = true
      )
  )
  or coalesce(auth.jwt() -> 'user_metadata' ->> 'role', '') = 'admin';
$$;

revoke all on function public.can_access_post_order_issues() from public;
grant execute on function public.can_access_post_order_issues() to authenticated;

create or replace function public.admin_set_employee_post_order_issue_access(
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
    raise exception 'Admin privileges are required to change Requests, Returns, and Disputes access'
      using errcode = '42501';
  end if;

  select e.id, e.user_id, e.post_order_issue_access
    into v_employee
  from public.employees e
  where e.user_id = _user_id
  limit 1;

  if not found then
    raise exception 'Employee user was not found'
      using errcode = 'P0002';
  end if;

  v_old := coalesce(v_employee.post_order_issue_access, false);

  update public.employees
  set post_order_issue_access = v_new
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
      'post_order_issues',
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
    'post_order_issue_access', v_new,
    'changed', v_old is distinct from v_new
  );
end;
$$;

revoke all on function public.admin_set_employee_post_order_issue_access(uuid, boolean) from public;
grant execute on function public.admin_set_employee_post_order_issue_access(uuid, boolean) to authenticated;

drop policy if exists "Inventory staff upload eBay return evidence" on storage.objects;
create policy "Inventory staff upload eBay return evidence"
on storage.objects
for insert
to authenticated
with check (bucket_id = 'ebay-return-evidence' and public.can_access_post_order_issues());

drop policy if exists "Inventory staff read eBay return evidence" on storage.objects;
create policy "Inventory staff read eBay return evidence"
on storage.objects
for select
to authenticated
using (bucket_id = 'ebay-return-evidence' and public.can_access_post_order_issues());

drop policy if exists "ebay_return_cases_inventory_staff_select" on public.ebay_return_cases;
create policy "ebay_return_cases_inventory_staff_select"
on public.ebay_return_cases
for select
to authenticated
using (public.can_access_post_order_issues());

drop policy if exists "ebay_return_items_inventory_staff_select" on public.ebay_return_items;
create policy "ebay_return_items_inventory_staff_select"
on public.ebay_return_items
for select
to authenticated
using (public.can_access_post_order_issues());

drop policy if exists "ebay_return_events_inventory_staff_select" on public.ebay_return_events;
create policy "ebay_return_events_inventory_staff_select"
on public.ebay_return_events
for select
to authenticated
using (public.can_access_post_order_issues());

drop policy if exists "ebay_return_cases_inventory_staff_insert" on public.ebay_return_cases;
create policy "ebay_return_cases_inventory_staff_insert"
on public.ebay_return_cases
for insert
to authenticated
with check (public.can_access_post_order_issues());

drop policy if exists "ebay_return_items_inventory_staff_insert" on public.ebay_return_items;
create policy "ebay_return_items_inventory_staff_insert"
on public.ebay_return_items
for insert
to authenticated
with check (public.can_access_post_order_issues());

drop policy if exists "ebay_return_events_inventory_staff_insert" on public.ebay_return_events;
create policy "ebay_return_events_inventory_staff_insert"
on public.ebay_return_events
for insert
to authenticated
with check (public.can_access_post_order_issues());

drop policy if exists "ebay_return_tasks_inventory_staff_select" on public.ebay_return_tasks;
create policy "ebay_return_tasks_inventory_staff_select"
on public.ebay_return_tasks
for select
to authenticated
using (public.can_access_post_order_issues());

drop policy if exists "ebay_return_tasks_inventory_staff_insert" on public.ebay_return_tasks;
create policy "ebay_return_tasks_inventory_staff_insert"
on public.ebay_return_tasks
for insert
to authenticated
with check (public.can_access_post_order_issues());

drop policy if exists "ebay_return_task_events_inventory_staff_select" on public.ebay_return_task_events;
create policy "ebay_return_task_events_inventory_staff_select"
on public.ebay_return_task_events
for select
to authenticated
using (public.can_access_post_order_issues());

drop policy if exists "ebay_return_task_events_inventory_staff_insert" on public.ebay_return_task_events;
create policy "ebay_return_task_events_inventory_staff_insert"
on public.ebay_return_task_events
for insert
to authenticated
with check (public.can_access_post_order_issues());

drop policy if exists "ebay_return_messages_inventory_staff_select" on public.ebay_return_messages;
create policy "ebay_return_messages_inventory_staff_select"
on public.ebay_return_messages
for select
to authenticated
using (public.can_access_post_order_issues());

drop policy if exists "ebay_return_messages_inventory_staff_insert" on public.ebay_return_messages;
create policy "ebay_return_messages_inventory_staff_insert"
on public.ebay_return_messages
for insert
to authenticated
with check (public.can_access_post_order_issues());

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
        'receive_ebay_return',
        'open_ebay_return_case',
        'open_unmatched_ebay_return_case',
        'sync_ebay_return_tasks_after_intake',
        'record_ebay_return_message_log',
        'update_ebay_return_task_export_metadata',
        'close_ebay_return_case_from_page',
        'reconcile_ebay_return_task_duplicates'
      )
  loop
    v_sql := pg_get_functiondef(v_fn.oid);
    v_updated := replace(v_sql, 'public.can_manage_inventory()', 'public.can_access_post_order_issues()');

    if v_updated is distinct from v_sql then
      execute v_updated;
    end if;
  end loop;
end $$;

comment on column public.employees.post_order_issue_access
  is 'When true, active non-admin employees can open eBay Requests, Returns, and Disputes from their dashboard.';

comment on function public.can_access_post_order_issues()
  is 'Returns true for active admins and active employees explicitly granted eBay Requests, Returns, and Disputes access.';
