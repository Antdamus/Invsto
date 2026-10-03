-- Correct shared completion photos without deleting files still used by other orders.
-- Keep the original attachment and actor in the event audit payload.
create or replace function public.correct_pending_order_completion_photo(
  _event_ids uuid[],
  _bucket text,
  _path text,
  _request_id uuid,
  _replacement jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
  v_event public.ebay_order_task_events;
  v_old jsonb;
  v_next jsonb;
  v_change jsonb;
  v_replacement jsonb;
  v_task_ids uuid[];
  v_count integer := 0;
  v_actor text := coalesce(auth.email(), 'Staff');
begin
  if auth.uid() is null or not public.can_manage_inventory() then
    raise exception 'Only inventory staff can correct completion photos' using errcode = '42501';
  end if;
  select array_agg(distinct id order by id) into v_ids
  from unnest(coalesce(_event_ids, '{}'::uuid[])) as ids(id) where id is not null;
  if coalesce(cardinality(v_ids), 0) = 0 or cardinality(v_ids) > 500
     or _request_id is null or _bucket is distinct from 'order-evidence-photos'
     or coalesce(_path, '') not like 'completion-photos/%' then
    raise exception 'A completion photo and its order events are required' using errcode = '22023';
  end if;
  if (select count(*) from public.ebay_order_task_events
      where id = any(v_ids) and payload->>'proof_type' = 'completion_photo') <> cardinality(v_ids) then
    raise exception 'One or more completion photo events were not found' using errcode = 'P0002';
  end if;

  -- Follow the same task-before-event lock order used by the add-photo RPC.
  select array_agg(distinct task_id order by task_id) into v_task_ids
  from public.ebay_order_task_events where id = any(v_ids);
  perform id from public.ebay_order_tasks where id = any(v_task_ids) order by id for update;

  if _replacement is not null then
    if jsonb_typeof(_replacement) is distinct from 'object'
       or _replacement->>'bucket' is distinct from 'order-evidence-photos'
       or coalesce(_replacement->>'path', '') not like 'completion-photos/%'
       or _replacement->>'path' = _path
       or not exists (select 1 from storage.objects where bucket_id = 'order-evidence-photos'
                      and name = _replacement->>'path') then
      raise exception 'Upload the replacement photo before replacing the original' using errcode = '22023';
    end if;
    v_replacement := _replacement || jsonb_build_object(
      'created_at', now(), 'signed_by_email', v_actor,
      'metadata', coalesce(_replacement->'metadata', '{}'::jsonb)
        || jsonb_build_object('source', 'pending_order_completion_photo')
    );
  end if;

  for v_event in select * from public.ebay_order_task_events where id = any(v_ids) order by id for update
  loop
    -- A client retry after a lost response must not repeat or undo a correction.
    select change into v_change
    from jsonb_array_elements(coalesce(v_event.payload->'completion_photo_changes', '[]'::jsonb)) change
    where change->>'request_id' = _request_id::text limit 1;
    if found then
      if v_change->>'path' is distinct from _path
         or v_change->>'bucket' is distinct from _bucket
         or v_change->'replacement'->>'path' is distinct from _replacement->>'path' then
        raise exception 'This correction request was already used for another photo' using errcode = '22023';
      end if;
      continue;
    end if;

    select jsonb_agg(photo order by ord) into v_old
    from jsonb_array_elements(coalesce(v_event.photo_attachments, '[]'::jsonb)) with ordinality as p(photo, ord)
    where photo->>'bucket' = _bucket and photo->>'path' = _path;
    if v_old is null then
      raise exception 'This photo has already changed. Refresh the photos and try again.' using errcode = '40001';
    end if;

    select coalesce(jsonb_agg(
      case when photo->>'bucket' is not distinct from _bucket and photo->>'path' is not distinct from _path
           then v_replacement else photo end order by ord
    ) filter (where not (photo->>'bucket' is not distinct from _bucket and photo->>'path' is not distinct from _path)
                    or v_replacement is not null), '[]'::jsonb)
    into v_next
    from jsonb_array_elements(coalesce(v_event.photo_attachments, '[]'::jsonb)) with ordinality as p(photo, ord);

    update public.ebay_order_task_events
    set photo_attachments = v_next,
        payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object(
          'photo_count', jsonb_array_length(v_next),
          'completion_photo_changes', coalesce(payload->'completion_photo_changes', '[]'::jsonb)
            || jsonb_build_array(jsonb_build_object(
              'request_id', _request_id, 'action', case when v_replacement is null then 'removed' else 'replaced' end,
              'bucket', _bucket, 'path', _path, 'original', v_old, 'replacement', v_replacement,
              'signed_by', auth.uid(), 'signed_by_email', v_actor, 'created_at', now()
            ))
        )
    where id = v_event.id;
    v_count := v_count + 1;
  end loop;

  update public.ebay_order_tasks task
  set latest_photo_count = (select coalesce(sum(jsonb_array_length(coalesce(event.photo_attachments, '[]'::jsonb))), 0)
                           from public.ebay_order_task_events event where event.task_id = task.id),
      updated_at = now()
  where task.id = any(v_task_ids);
  return jsonb_build_object('updated_events', v_count, 'request_id', _request_id);
end;
$$;

revoke all on function public.correct_pending_order_completion_photo(uuid[], text, text, uuid, jsonb) from public, anon;
grant execute on function public.correct_pending_order_completion_photo(uuid[], text, text, uuid, jsonb) to authenticated;
