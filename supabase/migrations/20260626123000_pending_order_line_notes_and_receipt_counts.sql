-- Add audited per-line pending-order notes and keep the fast pending queue
-- aware of video-receipt coverage without loading every task event client-side.

create index if not exists ebay_order_tasks_metadata_source_idx
  on public.ebay_order_tasks ((metadata->>'source'))
  where metadata ? 'source';

create index if not exists ebay_order_task_events_payload_source_idx
  on public.ebay_order_task_events ((payload->>'source'))
  where payload ? 'source';

create or replace function public.add_pending_order_line_note(
  _order_line_id uuid,
  _note text,
  _photo_attachments jsonb default '[]'::jsonb,
  _signed_by_email text default null
)
returns public.ebay_order_task_events
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_line public.ebay_order_lines;
  v_order public.ebay_orders;
  v_task public.ebay_order_tasks;
  v_event public.ebay_order_task_events;
  v_note text := nullif(btrim(coalesce(_note, '')), '');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
  v_photo_attachments jsonb := case
    when jsonb_typeof(coalesce(_photo_attachments, '[]'::jsonb)) = 'array'
      then coalesce(_photo_attachments, '[]'::jsonb)
    else '[]'::jsonb
  end;
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to add pending-order line notes' using errcode = '42501';
  end if;

  if v_note is null then
    raise exception 'A note is required' using errcode = '22023';
  end if;

  select *
    into v_line
  from public.ebay_order_lines
  where id = _order_line_id;

  if not found then
    raise exception 'eBay order line not found' using errcode = 'P0002';
  end if;

  select *
    into v_order
  from public.ebay_orders
  where id = v_line.order_id;

  if not found then
    raise exception 'eBay order not found' using errcode = 'P0002';
  end if;

  select *
    into v_task
  from public.ebay_order_tasks
  where order_id = v_order.id
    and metadata->>'source' = 'pending_order_line_note'
    and v_line.id = any(order_line_ids)
  order by created_at desc
  limit 1
  for update;

  if found then
    update public.ebay_order_tasks
    set latest_note = v_note,
        latest_photo_count = coalesce(latest_photo_count, 0) + jsonb_array_length(v_photo_attachments),
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
          'source', 'pending_order_line_note',
          'hidden_from_task_board', true,
          'last_note_at', now(),
          'last_photo_count', jsonb_array_length(v_photo_attachments),
          'order_number', v_order.order_number,
          'buyer_username', v_order.buyer_username,
          'buyer_name', v_order.buyer_name,
          'item_number', v_line.item_number,
          'item_title', v_line.item_title
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
      array[v_line.id]::uuid[],
      'coordination',
      concat('Order line notes - ', coalesce(v_order.order_number, 'eBay order')),
      'Hidden pending-order line note container',
      'resolved',
      'low',
      v_note,
      jsonb_array_length(v_photo_attachments),
      now(),
      auth.uid(),
      v_signed_email,
      'Pending-order line note evidence container.',
      auth.uid(),
      v_signed_email,
      jsonb_build_object(
        'source', 'pending_order_line_note',
        'hidden_from_task_board', true,
        'created_from', 'pending_orders',
        'order_number', v_order.order_number,
        'order_status', v_order.status,
        'buyer_username', v_order.buyer_username,
        'buyer_name', v_order.buyer_name,
        'item_number', v_line.item_number,
        'item_title', v_line.item_title,
        'order_total_price', v_order.total_price,
        'line_total_price', v_line.total_price
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
    'commented',
    v_task.status,
    v_task.status,
    v_note,
    v_photo_attachments,
    auth.uid(),
    v_signed_email,
    jsonb_build_object(
      'source', 'pending_order_line_note',
      'order_line_id', v_line.id,
      'order_line_ids', jsonb_build_array(v_line.id),
      'order_number', v_order.order_number,
      'buyer_username', v_order.buyer_username,
      'buyer_name', v_order.buyer_name,
      'item_number', v_line.item_number,
      'item_title', v_line.item_title,
      'photo_count', jsonb_array_length(v_photo_attachments)
    )
  )
  returning * into v_event;

  return v_event;
end;
$$;

revoke all on function public.add_pending_order_line_note(uuid, text, jsonb, text) from public;
grant execute on function public.add_pending_order_line_note(uuid, text, jsonb, text) to authenticated;

comment on function public.add_pending_order_line_note(uuid, text, jsonb, text)
  is 'Stores an audited visible note and optional photos for one pending eBay order line using a hidden resolved task container.';

drop function if exists public.list_pending_ebay_order_queue(text, boolean, integer, integer);

create or replace function public.list_pending_ebay_order_queue(
  _status text default 'pending',
  _include_admin_fields boolean default false,
  _limit integer default 1000,
  _offset integer default 0
)
returns table (
  id uuid,
  order_id uuid,
  item_number text,
  transaction_id text,
  item_title text,
  custom_label text,
  quantity integer,
  sold_for numeric,
  shipping_and_handling numeric,
  total_price numeric,
  net_payout numeric,
  line_status text,
  created_at timestamptz,
  internal_item_id uuid,
  fulfilled_quantity integer,
  fulfilled_at timestamptz,
  assigned_seller_employee_id uuid,
  assigned_seller_snapshot jsonb,
  notes text,
  order_record_id uuid,
  order_number text,
  sales_record_number text,
  buyer_username text,
  buyer_name text,
  sale_date timestamptz,
  paid_on_date timestamptz,
  imported_at timestamptz,
  ship_by_date timestamptz,
  payment_method text,
  order_shipping_and_handling numeric,
  ebay_collected_tax numeric,
  order_total_price numeric,
  order_net_payout numeric,
  order_status text,
  label_status text,
  label_storage_bucket text,
  label_file_path text,
  label_uploaded_at timestamptz,
  video_receipt_photo_count integer,
  line_note_count integer,
  latest_line_note text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text := lower(coalesce(nullif(btrim(_status), ''), 'pending'));
  v_limit integer := least(greatest(coalesce(_limit, 1000), 1), 2000);
  v_offset integer := greatest(coalesce(_offset, 0), 0);
  v_is_admin boolean := public.is_admin();
  v_include_admin_fields boolean := v_is_admin and coalesce(_include_admin_fields, false);
  v_line_statuses text[];
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  v_line_statuses := case
    when v_status = 'pending' then array['pending', 'partially_fulfilled']::text[]
    when v_status = 'fulfilled' then array['fulfilled']::text[]
    else array['pending', 'partially_fulfilled', 'fulfilled']::text[]
  end;

  return query
  with selected_lines as (
    select
      l.id,
      l.order_id,
      l.item_number,
      l.transaction_id,
      l.item_title,
      l.custom_label,
      l.quantity,
      l.sold_for,
      l.shipping_and_handling,
      l.total_price,
      case when v_include_admin_fields then l.net_payout else null::numeric end as net_payout,
      l.line_status,
      l.created_at,
      l.internal_item_id,
      l.fulfilled_quantity,
      l.fulfilled_at,
      l.assigned_seller_employee_id,
      coalesce(l.assigned_seller_snapshot, '{}'::jsonb) as assigned_seller_snapshot,
      l.notes,
      o.id as order_record_id,
      o.order_number,
      o.sales_record_number,
      o.buyer_username,
      o.buyer_name,
      o.sale_date,
      o.paid_on_date,
      o.imported_at,
      o.ship_by_date,
      case when v_include_admin_fields then o.payment_method else null::text end as payment_method,
      case when v_include_admin_fields then o.shipping_and_handling else null::numeric end as order_shipping_and_handling,
      case when v_include_admin_fields then o.ebay_collected_tax else null::numeric end as ebay_collected_tax,
      o.total_price as order_total_price,
      case when v_include_admin_fields then o.net_payout else null::numeric end as order_net_payout,
      o.status as order_status,
      o.label_status,
      o.label_storage_bucket,
      o.label_file_path,
      o.label_uploaded_at
    from public.ebay_order_lines l
    join public.ebay_orders o on o.id = l.order_id
    where l.line_status = any(v_line_statuses)
    order by l.created_at desc, l.id desc
    limit v_limit
    offset v_offset
  ),
  line_task_events as (
    select
      sl.id as line_id,
      t.id as task_id,
      coalesce(t.metadata, '{}'::jsonb) as task_metadata,
      e.id as event_id,
      e.created_at as event_created_at,
      e.notes,
      coalesce(e.photo_attachments, '[]'::jsonb) as photo_attachments,
      coalesce(e.payload, '{}'::jsonb) as payload
    from selected_lines sl
    join public.ebay_order_tasks t
      on t.order_id = sl.order_id
     and (
       cardinality(coalesce(t.order_line_ids, '{}'::uuid[])) = 0
       or sl.id = any(t.order_line_ids)
     )
    join public.ebay_order_task_events e on e.task_id = t.id
  ),
  video_counts as (
    select
      event_rows.line_id,
      count(*)::integer as photo_count
    from line_task_events event_rows
    cross join lateral jsonb_array_elements(event_rows.photo_attachments) as photo(value)
    where lower(concat_ws(
      ' ',
      photo.value->>'label',
      photo.value->>'path',
      photo.value->>'source_path',
      photo.value->>'source',
      photo.value #>> '{metadata,source}',
      photo.value #>> '{metadata,videoReceiptUrl}',
      photo.value #>> '{metadata,pageUrl}'
    )) ~ '(video[-_[:space:]]?receipt|ebaylive/events)'
    group by event_rows.line_id
  ),
  line_note_events as (
    select
      line_id,
      count(*)::integer as note_count,
      (array_agg(nullif(btrim(notes), '') order by event_created_at desc)
        filter (where nullif(btrim(notes), '') is not null))[1] as latest_note
    from line_task_events
    where payload->>'source' = 'pending_order_line_note'
       or task_metadata->>'source' = 'pending_order_line_note'
    group by line_id
  )
  select
    sl.id,
    sl.order_id,
    sl.item_number,
    sl.transaction_id,
    sl.item_title,
    sl.custom_label,
    sl.quantity,
    sl.sold_for,
    sl.shipping_and_handling,
    sl.total_price,
    sl.net_payout,
    sl.line_status,
    sl.created_at,
    sl.internal_item_id,
    sl.fulfilled_quantity,
    sl.fulfilled_at,
    sl.assigned_seller_employee_id,
    sl.assigned_seller_snapshot,
    sl.notes,
    sl.order_record_id,
    sl.order_number,
    sl.sales_record_number,
    sl.buyer_username,
    sl.buyer_name,
    sl.sale_date,
    sl.paid_on_date,
    sl.imported_at,
    sl.ship_by_date,
    sl.payment_method,
    sl.order_shipping_and_handling,
    sl.ebay_collected_tax,
    sl.order_total_price,
    sl.order_net_payout,
    sl.order_status,
    sl.label_status,
    sl.label_storage_bucket,
    sl.label_file_path,
    sl.label_uploaded_at,
    coalesce(video_counts.photo_count, 0)::integer as video_receipt_photo_count,
    coalesce(line_note_events.note_count, 0)::integer as line_note_count,
    coalesce(line_note_events.latest_note, '')::text as latest_line_note
  from selected_lines sl
  left join video_counts on video_counts.line_id = sl.id
  left join line_note_events on line_note_events.line_id = sl.id
  order by sl.created_at desc, sl.id desc;
end;
$$;

revoke all on function public.list_pending_ebay_order_queue(text, boolean, integer, integer) from public;
grant execute on function public.list_pending_ebay_order_queue(text, boolean, integer, integer) to authenticated;

comment on function public.list_pending_ebay_order_queue(text, boolean, integer, integer)
  is 'Lightweight pending eBay order queue read path with line prices, video-receipt coverage counts, and audited item-note counts.';
