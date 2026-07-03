-- Let staff add lightweight audited updates to eBay return tasks without
-- changing the task status.

alter table public.ebay_return_tasks
  add column if not exists latest_note text;

alter table public.ebay_return_tasks
  add column if not exists latest_photo_count integer not null default 0;

create or replace function public.add_ebay_return_task_update(
  _task_id uuid,
  _note text,
  _signed_by_email text default null
)
returns public.ebay_return_tasks
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task public.ebay_return_tasks;
  v_note text := nullif(btrim(coalesce(_note, '')), '');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
begin
  if v_note is null then
    raise exception 'Write an update before saving.' using errcode = '22023';
  end if;

  select *
    into v_task
  from public.ebay_return_tasks
  where id = _task_id
  for update;

  if not found then
    raise exception 'Return task not found' using errcode = 'P0002';
  end if;

  if not (public.is_admin() or v_task.assigned_to_user_id = auth.uid() or v_task.created_by = auth.uid()) then
    raise exception 'Not allowed to update this eBay return task' using errcode = '42501';
  end if;

  update public.ebay_return_tasks
  set latest_note = v_note
  where id = v_task.id
  returning * into v_task;

  insert into public.ebay_return_task_events (
    task_id,
    return_case_id,
    action,
    old_status,
    new_status,
    notes,
    signed_by,
    signed_by_email,
    payload
  )
  values (
    v_task.id,
    v_task.return_case_id,
    'commented',
    v_task.status,
    v_task.status,
    v_note,
    auth.uid(),
    v_signed_email,
    jsonb_build_object('source', 'return_task_internal_update')
  );

  return v_task;
end;
$$;

revoke all on function public.add_ebay_return_task_update(uuid, text, text) from public;
grant execute on function public.add_ebay_return_task_update(uuid, text, text) to authenticated;
