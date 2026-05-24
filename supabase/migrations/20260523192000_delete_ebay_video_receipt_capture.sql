-- Remove an incorrect eBay video receipt capture from an order coordination event.
-- This keeps the task/event audit record while removing the mistaken photo attachment.

create or replace function public.delete_ebay_video_receipt_capture(
  _event_id uuid,
  _bucket text,
  _path text,
  _signed_by_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  v_event public.ebay_order_task_events%rowtype;
  v_task public.ebay_order_tasks%rowtype;
  v_bucket text := coalesce(nullif(_bucket, ''), 'order-evidence-photos');
  v_path text := nullif(_path, '');
  v_photos jsonb := '[]'::jsonb;
  v_removed_count integer := 0;
  v_actor_email text := coalesce(nullif(_signed_by_email, ''), auth.email(), 'unknown');
begin
  if not public.can_manage_inventory() then
    raise exception 'Only inventory staff can delete video receipt captures' using errcode = '42501';
  end if;

  if _event_id is null or v_path is null then
    raise exception 'A task event and photo path are required' using errcode = '22023';
  end if;

  select *
  into v_event
  from public.ebay_order_task_events
  where id = _event_id
  for update;

  if not found then
    raise exception 'Video receipt capture event not found' using errcode = 'P0002';
  end if;

  select *
  into v_task
  from public.ebay_order_tasks
  where id = v_event.task_id
  for update;

  if not found then
    raise exception 'Order coordination task not found' using errcode = 'P0002';
  end if;

  select coalesce(jsonb_agg(photo) filter (
           where not (
             coalesce(photo->>'bucket', photo->>'storage_bucket', 'order-evidence-photos') = v_bucket
             and coalesce(photo->>'path', photo->>'storage_path', photo->>'source_path') = v_path
           )
         ), '[]'::jsonb),
         count(*) filter (
           where coalesce(photo->>'bucket', photo->>'storage_bucket', 'order-evidence-photos') = v_bucket
             and coalesce(photo->>'path', photo->>'storage_path', photo->>'source_path') = v_path
         )
  into v_photos, v_removed_count
  from jsonb_array_elements(coalesce(v_event.photo_attachments, '[]'::jsonb)) as photo;

  if coalesce(v_removed_count, 0) = 0 then
    raise exception 'Video receipt capture was not attached to this event' using errcode = 'P0002';
  end if;

  update public.ebay_order_task_events
  set photo_attachments = v_photos,
      notes = trim(both from concat_ws(
        E'\n',
        nullif(v_event.notes, ''),
        format('Removed mistaken video receipt capture %s by %s at %s.', v_path, v_actor_email, to_char(now(), 'YYYY-MM-DD HH24:MI TZ'))
      ))
  where id = _event_id;

  update public.ebay_order_tasks
  set latest_photo_count = greatest(coalesce(latest_photo_count, 0) - v_removed_count, 0),
      latest_note = trim(both from concat_ws(
        E'\n',
        nullif(latest_note, ''),
        format('Removed mistaken video receipt capture by %s.', v_actor_email)
      ))
  where id = v_task.id;

  delete from storage.objects
  where bucket_id = v_bucket
    and name = v_path;

  return jsonb_build_object(
    'event_id', _event_id,
    'bucket', v_bucket,
    'path', v_path,
    'removed_count', v_removed_count
  );
end;
$$;

revoke all on function public.delete_ebay_video_receipt_capture(uuid, text, text, text) from public;
grant execute on function public.delete_ebay_video_receipt_capture(uuid, text, text, text) to authenticated;
