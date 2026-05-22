-- Preserve parsed eBay return export metadata on return tasks without changing
-- older migrations that may already be applied.

create or replace function public.update_ebay_return_task_export_metadata(
  _task_id uuid,
  _due_at timestamptz default null,
  _metadata_patch jsonb default '{}'::jsonb,
  _notes text default null,
  _signed_by_email text default null
)
returns public.ebay_return_tasks
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task public.ebay_return_tasks;
  v_old_due_at timestamptz;
  v_patch jsonb := case
    when jsonb_typeof(coalesce(_metadata_patch, '{}'::jsonb)) = 'object'
      then coalesce(_metadata_patch, '{}'::jsonb)
    else jsonb_build_object('metadata_patch', _metadata_patch)
  end;
  v_notes text := nullif(btrim(coalesce(_notes, '')), '');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to update eBay return task metadata' using errcode = '42501';
  end if;

  select *
    into v_task
  from public.ebay_return_tasks
  where id = _task_id
  for update;

  if not found then
    raise exception 'Return task not found' using errcode = 'P0002';
  end if;

  v_old_due_at := v_task.due_at;

  update public.ebay_return_tasks
  set due_at = coalesce(_due_at, due_at),
      metadata = coalesce(metadata, '{}'::jsonb)
        || v_patch
        || jsonb_build_object('exportMetadataUpdatedAt', now()),
      updated_at = now()
  where id = _task_id
  returning * into v_task;

  update public.ebay_return_cases
  set raw_payload = coalesce(raw_payload, '{}'::jsonb)
      || v_patch
      || jsonb_build_object('exportMetadataUpdatedAt', now())
  where id = v_task.return_case_id;

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
    coalesce(v_notes, 'eBay return export metadata updated.'),
    auth.uid(),
    v_signed_email,
    jsonb_build_object(
      'old_due_at', v_old_due_at,
      'new_due_at', v_task.due_at,
      'metadata_patch', v_patch
    )
  );

  return v_task;
end;
$$;

grant execute on function public.update_ebay_return_task_export_metadata(uuid, timestamptz, jsonb, text, text) to authenticated;
