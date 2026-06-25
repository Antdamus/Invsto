-- Per-user task read states for the unified task queue.
-- This lets the UI distinguish unread tasks, tasks with unseen updates, and read tasks.

create table if not exists public.task_read_states (
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (source in ('team', 'order', 'return')),
  task_id uuid not null,
  last_seen_at timestamptz not null default now(),
  last_seen_task_updated_at timestamptz,
  last_seen_event_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, source, task_id)
);

alter table public.task_read_states enable row level security;

create index if not exists task_read_states_user_updated_idx
  on public.task_read_states(user_id, updated_at desc);

create index if not exists task_read_states_task_idx
  on public.task_read_states(source, task_id);

drop policy if exists "task_read_states_self_or_admin_select" on public.task_read_states;
create policy "task_read_states_self_or_admin_select"
on public.task_read_states
for select
to authenticated
using (user_id = auth.uid() or public.is_admin());

drop policy if exists "task_read_states_self_insert" on public.task_read_states;
create policy "task_read_states_self_insert"
on public.task_read_states
for insert
to authenticated
with check (user_id = auth.uid() or public.is_admin());

drop policy if exists "task_read_states_self_or_admin_update" on public.task_read_states;
create policy "task_read_states_self_or_admin_update"
on public.task_read_states
for update
to authenticated
using (user_id = auth.uid() or public.is_admin())
with check (user_id = auth.uid() or public.is_admin());

grant select, insert, update on public.task_read_states to authenticated;

create or replace function public.mark_task_seen(
  _source text,
  _task_id uuid,
  _last_seen_task_updated_at timestamptz default null,
  _last_seen_event_at timestamptz default null
)
returns public.task_read_states
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_row public.task_read_states;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if _source not in ('team', 'order', 'return') then
    raise exception 'Invalid task source: %', _source using errcode = '22023';
  end if;

  insert into public.task_read_states (
    user_id,
    source,
    task_id,
    last_seen_at,
    last_seen_task_updated_at,
    last_seen_event_at,
    updated_at
  )
  values (
    v_user_id,
    _source,
    _task_id,
    now(),
    _last_seen_task_updated_at,
    _last_seen_event_at,
    now()
  )
  on conflict (user_id, source, task_id)
  do update set
    last_seen_at = excluded.last_seen_at,
    last_seen_task_updated_at = coalesce(excluded.last_seen_task_updated_at, public.task_read_states.last_seen_task_updated_at),
    last_seen_event_at = coalesce(excluded.last_seen_event_at, public.task_read_states.last_seen_event_at),
    updated_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.mark_task_seen(text, uuid, timestamptz, timestamptz) to authenticated;

comment on table public.task_read_states
  is 'Per-user read cursors for the unified task queue. Used by team-tasks.html to show unread and unseen-update states.';
