-- Allow staff to add post-close proof photos to eBay Order History records.
-- The photos are stored as audited task events, but the backing task is hidden
-- and resolved so it does not appear as active work.

alter table public.ebay_order_task_events
  drop constraint if exists ebay_order_task_events_action_check;

alter table public.ebay_order_task_events
  add constraint ebay_order_task_events_action_check
  check (action in (
    'created',
    'assigned',
    'status_changed',
    'commented',
    'resolved',
    'cancelled',
    'subtask_created',
    'progress_update',
    'reassign_requested',
    'completed_by_employee',
    'sent_back_for_rework',
    'approved_by_admin',
    'approved_for_shipping',
    'shipment_assigned',
    'shipping_ready_for_packaging',
    'shipping_handoff',
    'packaging_assigned',
    'shipped_completed',
    'history_extra_photo'
  ));

create or replace function public.add_ebay_order_history_extra_photos(
  _order_id uuid,
  _order_line_ids uuid[] default '{}'::uuid[],
  _photo_attachments jsonb default '[]'::jsonb,
  _note text default null,
  _proof_type text default 'correction_photo',
  _signed_by_email text default null
)
returns public.ebay_order_task_events
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.ebay_orders;
  v_task public.ebay_order_tasks;
  v_event public.ebay_order_task_events;
  v_requested_line_ids uuid[] := '{}'::uuid[];
  v_line_ids uuid[] := '{}'::uuid[];
  v_all_line_ids uuid[] := '{}'::uuid[];
  v_photo_attachments jsonb := case
    when jsonb_typeof(coalesce(_photo_attachments, '[]'::jsonb)) = 'array'
      then coalesce(_photo_attachments, '[]'::jsonb)
    else '[]'::jsonb
  end;
  v_note text := nullif(btrim(coalesce(_note, '')), '');
  v_proof_type text := coalesce(nullif(btrim(coalesce(_proof_type, '')), ''), 'correction_photo');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to add order history photos' using errcode = '42501';
  end if;

  if jsonb_array_length(v_photo_attachments) = 0 then
    raise exception 'At least one photo is required' using errcode = '22023';
  end if;

  select *
    into v_order
  from public.ebay_orders
  where id = _order_id;

  if not found then
    raise exception 'eBay order not found' using errcode = 'P0002';
  end if;

  select coalesce(array_agg(distinct entry.line_id), '{}'::uuid[])
    into v_requested_line_ids
  from unnest(coalesce(_order_line_ids, '{}'::uuid[])) as entry(line_id)
  where entry.line_id is not null;

  if cardinality(v_requested_line_ids) > 0 then
    select coalesce(array_agg(line.id), '{}'::uuid[])
      into v_line_ids
    from public.ebay_order_lines line
    where line.order_id = v_order.id
      and line.id = any(v_requested_line_ids);

    if cardinality(v_line_ids) <> cardinality(v_requested_line_ids) then
      raise exception 'One or more selected order lines do not belong to this eBay order' using errcode = '22023';
    end if;
  else
    select coalesce(array_agg(line.id), '{}'::uuid[])
      into v_line_ids
    from public.ebay_order_lines line
    where line.order_id = v_order.id;
  end if;

  if cardinality(v_line_ids) = 0 then
    raise exception 'No order lines found for this eBay order' using errcode = 'P0002';
  end if;

  select *
    into v_task
  from public.ebay_order_tasks
  where order_id = v_order.id
    and metadata->>'source' = 'order_history_extra_photo'
  order by created_at desc
  limit 1;

  if found then
    select coalesce(array_agg(distinct entry.line_id), '{}'::uuid[])
      into v_all_line_ids
    from unnest(coalesce(v_task.order_line_ids, '{}'::uuid[]) || v_line_ids) as entry(line_id)
    where entry.line_id is not null;

    update public.ebay_order_tasks
    set order_line_ids = v_all_line_ids,
        latest_note = coalesce(v_note, latest_note),
        latest_photo_count = coalesce(latest_photo_count, 0) + jsonb_array_length(v_photo_attachments),
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
          'source', 'order_history_extra_photo',
          'hidden_from_task_board', true,
          'last_extra_photo_at', now(),
          'last_proof_type', v_proof_type
        ),
        updated_at = now()
    where id = v_task.id
    returning * into v_task;
  else
    insert into public.ebay_order_tasks (
      order_id,
      order_line_ids,
      task_type,
      title,
      question,
      status,
      priority,
      latest_note,
      latest_photo_count,
      resolved_at,
      resolved_by,
      resolved_by_email,
      resolution_notes,
      created_by,
      created_by_email,
      metadata
    )
    values (
      v_order.id,
      v_line_ids,
      'coordination',
      concat('Order history proof photos - ', coalesce(v_order.order_number, 'eBay order')),
      'Hidden order-history evidence container',
      'resolved',
      'low',
      v_note,
      jsonb_array_length(v_photo_attachments),
      now(),
      auth.uid(),
      v_signed_email,
      'Post-close order-history proof photo container.',
      auth.uid(),
      v_signed_email,
      jsonb_build_object(
        'source', 'order_history_extra_photo',
        'hidden_from_task_board', true,
        'created_from', 'ebay_order_history',
        'order_number', v_order.order_number,
        'order_status', v_order.status,
        'buyer_username', v_order.buyer_username,
        'buyer_name', v_order.buyer_name,
        'line_count', cardinality(v_line_ids),
        'order_total_price', v_order.total_price,
        'order_net_payout', v_order.net_payout
      )
    )
    returning * into v_task;
  end if;

  insert into public.ebay_order_task_events (
    task_id,
    order_id,
    action,
    old_status,
    new_status,
    notes,
    photo_attachments,
    signed_by,
    signed_by_email,
    payload
  )
  values (
    v_task.id,
    v_order.id,
    'history_extra_photo',
    v_task.status,
    v_task.status,
    v_note,
    v_photo_attachments,
    auth.uid(),
    v_signed_email,
    jsonb_build_object(
      'source', 'order_history_extra_photo',
      'proof_type', v_proof_type,
      'order_line_ids', to_jsonb(v_line_ids),
      'order_number', v_order.order_number,
      'buyer_username', v_order.buyer_username,
      'buyer_name', v_order.buyer_name,
      'photo_count', jsonb_array_length(v_photo_attachments)
    )
  )
  returning * into v_event;

  return v_event;
end;
$$;

revoke all on function public.add_ebay_order_history_extra_photos(uuid, uuid[], jsonb, text, text, text) from public;
grant execute on function public.add_ebay_order_history_extra_photos(uuid, uuid[], jsonb, text, text, text) to authenticated;
