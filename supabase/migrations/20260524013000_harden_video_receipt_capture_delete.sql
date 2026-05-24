-- Make video receipt capture deletion remove the exact image anywhere it is attached
-- within the same order, then close empty video-receipt-only coordination tasks.

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
  v_seed_event public.ebay_order_task_events%rowtype;
  v_bucket text := coalesce(nullif(_bucket, ''), 'order-evidence-photos');
  v_path text := nullif(_path, '');
  v_actor_email text := coalesce(nullif(_signed_by_email, ''), auth.email(), 'unknown');
  v_event record;
  v_next_photos jsonb;
  v_removed_in_event integer;
  v_removed_count integer := 0;
  v_updated_events integer := 0;
  v_storage_removed integer := 0;
  v_remaining_photos integer;
begin
  if not public.can_manage_inventory() then
    raise exception 'Only inventory staff can delete video receipt captures' using errcode = '42501';
  end if;

  if _event_id is null or v_path is null then
    raise exception 'A task event and photo path are required' using errcode = '22023';
  end if;

  select *
  into v_seed_event
  from public.ebay_order_task_events
  where id = _event_id;

  if not found then
    raise exception 'Video receipt capture event not found' using errcode = 'P0002';
  end if;

  for v_event in
    select *
    from public.ebay_order_task_events
    where order_id = v_seed_event.order_id
      and exists (
        select 1
        from jsonb_array_elements(coalesce(photo_attachments, '[]'::jsonb)) as photo
        where coalesce(photo->>'bucket', photo->>'storage_bucket', 'order-evidence-photos') = v_bucket
          and coalesce(photo->>'path', photo->>'storage_path') = v_path
      )
    for update
  loop
    select coalesce(jsonb_agg(photo) filter (
             where not (
               coalesce(photo->>'bucket', photo->>'storage_bucket', 'order-evidence-photos') = v_bucket
               and coalesce(photo->>'path', photo->>'storage_path') = v_path
             )
           ), '[]'::jsonb),
           count(*) filter (
             where coalesce(photo->>'bucket', photo->>'storage_bucket', 'order-evidence-photos') = v_bucket
               and coalesce(photo->>'path', photo->>'storage_path') = v_path
           )
    into v_next_photos, v_removed_in_event
    from jsonb_array_elements(coalesce(v_event.photo_attachments, '[]'::jsonb)) as photo;

    if coalesce(v_removed_in_event, 0) > 0 then
      update public.ebay_order_task_events
      set photo_attachments = v_next_photos,
          notes = trim(both from concat_ws(
            E'\n',
            nullif(v_event.notes, ''),
            format('Removed mistaken video receipt capture %s by %s at %s.', v_path, v_actor_email, to_char(now(), 'YYYY-MM-DD HH24:MI TZ'))
          ))
      where id = v_event.id;

      v_removed_count := v_removed_count + v_removed_in_event;
      v_updated_events := v_updated_events + 1;
    end if;
  end loop;

  if v_removed_count = 0 then
    raise exception 'Video receipt capture was not attached to this order coordination event' using errcode = 'P0002';
  end if;

  for v_event in
    select distinct task_id
    from public.ebay_order_task_events
    where order_id = v_seed_event.order_id
  loop
    select coalesce(sum(jsonb_array_length(coalesce(photo_attachments, '[]'::jsonb))), 0)
    into v_remaining_photos
    from public.ebay_order_task_events
    where task_id = v_event.task_id;

    update public.ebay_order_tasks
    set latest_photo_count = v_remaining_photos,
        status = case
          when v_remaining_photos = 0
            and status not in ('resolved', 'cancelled')
            and (
              title ilike '%video receipt screenshot captured%'
              or question ilike '%video receipt screenshot captured%'
            )
            then 'cancelled'
          else status
        end,
        resolved_at = case
          when v_remaining_photos = 0
            and status not in ('resolved', 'cancelled')
            and (
              title ilike '%video receipt screenshot captured%'
              or question ilike '%video receipt screenshot captured%'
            )
            then now()
          else resolved_at
        end,
        resolution_notes = case
          when v_remaining_photos = 0
            and (
              title ilike '%video receipt screenshot captured%'
              or question ilike '%video receipt screenshot captured%'
            )
            then trim(both from concat_ws(E'\n', nullif(resolution_notes, ''), format('Mistaken video receipt capture deleted by %s.', v_actor_email)))
          else resolution_notes
        end,
        latest_note = trim(both from concat_ws(
          E'\n',
          nullif(latest_note, ''),
          format('Removed mistaken video receipt capture by %s.', v_actor_email)
        ))
    where id = v_event.task_id;
  end loop;

  delete from storage.objects
  where bucket_id = v_bucket
    and name = v_path;
  get diagnostics v_storage_removed = row_count;

  return jsonb_build_object(
    'event_id', _event_id,
    'bucket', v_bucket,
    'path', v_path,
    'removed_count', v_removed_count,
    'updated_events', v_updated_events,
    'storage_removed', v_storage_removed
  );
end;
$$;

revoke all on function public.delete_ebay_video_receipt_capture(uuid, text, text, text) from public;
grant execute on function public.delete_ebay_video_receipt_capture(uuid, text, text, text) to authenticated;
