-- Route completed team tasks into an acceptance bucket before final closure.

alter table public.team_tasks
  drop constraint if exists team_tasks_status_check;

alter table public.team_tasks
  add constraint team_tasks_status_check
  check (status in (
    'open',
    'assigned',
    'in_progress',
    'waiting_on_admin',
    'waiting_on_worker',
    'blocked',
    'deferred',
    'resolved',
    'cancelled',
    'pending_admin_review',
    'ready_for_admin_approval',
    'completed_by_employee',
    'sent_back_for_rework',
    'approved_by_admin'
  ));

alter table public.team_task_events
  drop constraint if exists team_task_events_action_check;

alter table public.team_task_events
  add constraint team_task_events_action_check
  check (action in (
    'created',
    'assigned',
    'status_changed',
    'commented',
    'resolved',
    'cancelled',
    'completed_by_employee',
    'sent_back_for_rework',
    'approved_by_admin'
  ));

drop policy if exists "team_tasks_visible_to_admin_assignee_creator" on public.team_tasks;
create policy "team_tasks_visible_to_admin_assignee_creator"
on public.team_tasks
for select
to authenticated
using (
  public.current_user_is_employee_admin()
  or assigned_to_user_id = auth.uid()
  or created_by = auth.uid()
  or assigned_by = auth.uid()
);

drop policy if exists "team_tasks_admin_assignee_creator_update" on public.team_tasks;
create policy "team_tasks_admin_assignee_creator_update"
on public.team_tasks
for update
to authenticated
using (
  public.current_user_is_employee_admin()
  or assigned_to_user_id = auth.uid()
  or created_by = auth.uid()
  or assigned_by = auth.uid()
)
with check (
  public.current_user_is_employee_admin()
  or assigned_to_user_id = auth.uid()
  or created_by = auth.uid()
  or assigned_by = auth.uid()
);

drop policy if exists "team_task_events_visible_to_task_participants" on public.team_task_events;
create policy "team_task_events_visible_to_task_participants"
on public.team_task_events
for select
to authenticated
using (
  exists (
    select 1
    from public.team_tasks t
    where t.id = team_task_events.task_id
      and (
        public.current_user_is_employee_admin()
        or t.assigned_to_user_id = auth.uid()
        or t.created_by = auth.uid()
        or t.assigned_by = auth.uid()
      )
  )
);

drop function if exists public.respond_team_task(uuid, text, uuid, text, text, jsonb, text);
drop function if exists public.respond_team_task(uuid, text, uuid, text, text, jsonb, text, timestamptz);

create or replace function public.respond_team_task(
  _task_id uuid,
  _note text default null,
  _assigned_to_user_id uuid default null,
  _status text default null,
  _priority text default null,
  _photo_attachments jsonb default '[]'::jsonb,
  _signed_by_email text default null,
  _due_at timestamptz default null
)
returns public.team_tasks
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task public.team_tasks;
  v_employee public.employees;
  v_old_status text;
  v_old_assigned uuid;
  v_old_due_at timestamptz;
  v_note text := nullif(btrim(coalesce(_note, '')), '');
  v_status text := nullif(btrim(coalesce(_status, '')), '');
  v_priority text := nullif(btrim(coalesce(_priority, '')), '');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
  v_action text := 'commented';
  v_photo_attachments jsonb := case
    when jsonb_typeof(coalesce(_photo_attachments, '[]'::jsonb)) = 'array'
      then coalesce(_photo_attachments, '[]'::jsonb)
    else '[]'::jsonb
  end;
begin
  select *
    into v_task
  from public.team_tasks
  where id = _task_id
  for update;

  if not found then
    raise exception 'Team task not found' using errcode = 'P0002';
  end if;

  if not (
    public.current_user_is_employee_admin()
    or v_task.assigned_to_user_id = auth.uid()
    or v_task.created_by = auth.uid()
    or v_task.assigned_by = auth.uid()
  ) then
    raise exception 'Not allowed to update this team task' using errcode = '42501';
  end if;

  if v_status is not null and v_status not in (
    'open', 'assigned', 'in_progress', 'waiting_on_admin', 'waiting_on_worker',
    'blocked', 'deferred', 'resolved', 'cancelled', 'pending_admin_review',
    'ready_for_admin_approval', 'completed_by_employee', 'sent_back_for_rework',
    'approved_by_admin'
  ) then
    raise exception 'Invalid team task status: %', v_status using errcode = '22023';
  end if;

  if v_status in ('completed_by_employee', 'sent_back_for_rework', 'resolved', 'cancelled') and v_note is null then
    raise exception 'A note is required for this task update' using errcode = '22023';
  end if;

  if v_priority is not null and v_priority not in ('low', 'normal', 'high', 'urgent') then
    raise exception 'Invalid team task priority: %', v_priority using errcode = '22023';
  end if;

  if v_status in ('resolved', 'approved_by_admin')
    and v_task.status in ('completed_by_employee', 'pending_admin_review', 'ready_for_admin_approval')
    and not (
      public.current_user_is_employee_admin()
      or v_task.created_by = auth.uid()
      or v_task.assigned_by = auth.uid()
    )
  then
    raise exception 'Only the task creator, assigner, or an admin can accept this completed task' using errcode = '42501';
  end if;

  if _assigned_to_user_id is not null then
    select *
      into v_employee
    from public.employees
    where user_id = _assigned_to_user_id
      and active is true
    limit 1;

    if not found then
      raise exception 'Assigned employee not found or inactive' using errcode = 'P0002';
    end if;
  end if;

  v_old_status := v_task.status;
  v_old_assigned := v_task.assigned_to_user_id;
  v_old_due_at := v_task.due_at;

  if _assigned_to_user_id is not null and v_status is null then
    v_status := case when v_employee.role = 'admin' then 'waiting_on_admin' else 'waiting_on_worker' end;
  end if;

  update public.team_tasks
  set assigned_to_user_id = coalesce(_assigned_to_user_id, assigned_to_user_id),
      assigned_to_employee_id = case when _assigned_to_user_id is null then assigned_to_employee_id else v_employee.id end,
      assigned_to_email = case when _assigned_to_user_id is null then assigned_to_email else v_employee.email end,
      assigned_to_role = case when _assigned_to_user_id is null then assigned_to_role else v_employee.role end,
      assigned_by = case when _assigned_to_user_id is null then assigned_by else auth.uid() end,
      assigned_by_email = case when _assigned_to_user_id is null then assigned_by_email else v_signed_email end,
      priority = coalesce(v_priority, priority),
      status = coalesce(v_status, status),
      due_at = coalesce(_due_at, due_at),
      latest_note = coalesce(v_note, latest_note),
      latest_photo_count = jsonb_array_length(v_photo_attachments),
      started_at = case when coalesce(v_status, status) = 'in_progress' and started_at is null then now() else started_at end,
      resolved_at = case when coalesce(v_status, status) in ('resolved', 'cancelled', 'approved_by_admin') then now() else resolved_at end,
      resolved_by = case when coalesce(v_status, status) in ('resolved', 'cancelled', 'approved_by_admin') then auth.uid() else resolved_by end,
      resolved_by_email = case when coalesce(v_status, status) in ('resolved', 'cancelled', 'approved_by_admin') then v_signed_email else resolved_by_email end,
      resolution_notes = case
        when coalesce(v_status, status) in ('resolved', 'cancelled', 'approved_by_admin', 'completed_by_employee', 'sent_back_for_rework') then v_note
        else resolution_notes
      end
  where id = _task_id
  returning * into v_task;

  v_action := case
    when v_task.status = 'completed_by_employee' then 'completed_by_employee'
    when v_task.status = 'sent_back_for_rework' then 'sent_back_for_rework'
    when v_task.status = 'approved_by_admin' then 'approved_by_admin'
    when v_task.status = 'resolved' then 'resolved'
    when v_task.status = 'cancelled' then 'cancelled'
    when v_old_assigned is distinct from v_task.assigned_to_user_id then 'assigned'
    when v_old_status is distinct from v_task.status then 'status_changed'
    else 'commented'
  end;

  insert into public.team_task_events (
    task_id,
    action,
    old_status,
    new_status,
    old_assigned_to_user_id,
    new_assigned_to_user_id,
    notes,
    photo_attachments,
    signed_by,
    signed_by_email,
    payload
  )
  values (
    v_task.id,
    v_action,
    v_old_status,
    v_task.status,
    v_old_assigned,
    v_task.assigned_to_user_id,
    v_note,
    v_photo_attachments,
    auth.uid(),
    v_signed_email,
    jsonb_build_object('old_due_at', v_old_due_at, 'due_at', v_task.due_at)
  );

  return v_task;
end;
$$;

drop function if exists public.list_my_team_tasks(integer);
drop function if exists public.list_admin_team_tasks(integer);

create or replace function public.list_my_team_tasks(_limit integer default 12)
returns table (
  id uuid,
  task_type text,
  title text,
  description text,
  status text,
  priority text,
  assigned_to_email text,
  assigned_to_user_id uuid,
  assigned_by uuid,
  assigned_by_email text,
  due_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  latest_note text,
  latest_photo_count integer,
  created_by uuid,
  created_by_email text,
  metadata jsonb
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    t.id,
    t.task_type,
    t.title,
    t.description,
    t.status,
    t.priority,
    t.assigned_to_email,
    t.assigned_to_user_id,
    t.assigned_by,
    t.assigned_by_email,
    t.due_at,
    t.created_at,
    t.updated_at,
    t.latest_note,
    t.latest_photo_count,
    t.created_by,
    t.created_by_email,
    t.metadata
  from public.team_tasks t
  where (
      t.assigned_to_user_id = auth.uid()
      or t.created_by = auth.uid()
      or t.assigned_by = auth.uid()
    )
    and t.status in (
      'open', 'assigned', 'in_progress', 'waiting_on_admin', 'waiting_on_worker',
      'blocked', 'deferred', 'pending_admin_review', 'ready_for_admin_approval',
      'completed_by_employee', 'sent_back_for_rework'
    )
    and t.metadata ->> 'history_removed_at' is null
  order by
    case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
    t.due_at nulls last,
    t.created_at asc
  limit greatest(1, least(coalesce(_limit, 12), 100));
$$;

create or replace function public.list_admin_team_tasks(_limit integer default 12)
returns table (
  id uuid,
  task_type text,
  title text,
  description text,
  status text,
  priority text,
  assigned_to_email text,
  assigned_to_user_id uuid,
  assigned_by uuid,
  assigned_by_email text,
  due_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  latest_note text,
  latest_photo_count integer,
  created_by uuid,
  created_by_email text,
  metadata jsonb
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.current_user_is_employee_admin() then
    raise exception 'Only admins can list all team tasks' using errcode = '42501';
  end if;

  return query
  select
    t.id,
    t.task_type,
    t.title,
    t.description,
    t.status,
    t.priority,
    t.assigned_to_email,
    t.assigned_to_user_id,
    t.assigned_by,
    t.assigned_by_email,
    t.due_at,
    t.created_at,
    t.updated_at,
    t.latest_note,
    t.latest_photo_count,
    t.created_by,
    t.created_by_email,
    t.metadata
  from public.team_tasks t
  where t.status in (
      'open', 'assigned', 'in_progress', 'waiting_on_admin', 'waiting_on_worker',
      'blocked', 'deferred', 'pending_admin_review', 'ready_for_admin_approval',
      'completed_by_employee', 'sent_back_for_rework'
    )
    and t.metadata ->> 'history_removed_at' is null
  order by
    case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
    t.due_at nulls last,
    t.created_at asc
  limit greatest(1, least(coalesce(_limit, 12), 100));
end;
$$;

revoke all on function public.respond_team_task(uuid, text, uuid, text, text, jsonb, text, timestamptz) from public;
revoke all on function public.list_my_team_tasks(integer) from public;
revoke all on function public.list_admin_team_tasks(integer) from public;

grant execute on function public.respond_team_task(uuid, text, uuid, text, text, jsonb, text, timestamptz) to authenticated;
grant execute on function public.list_my_team_tasks(integer) to authenticated;
grant execute on function public.list_admin_team_tasks(integer) to authenticated;
