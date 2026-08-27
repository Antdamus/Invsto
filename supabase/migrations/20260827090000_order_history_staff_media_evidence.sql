-- Let staff add post-close order-history evidence beyond photos:
-- item photos, videos, external label PDFs/screenshots, and manual tracking.

drop policy if exists "Post-order staff upload order history evidence" on storage.objects;
create policy "Post-order staff upload order history evidence"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'order-evidence-photos'
  and (public.can_manage_inventory() or public.can_access_post_order_issues())
);

drop policy if exists "Post-order staff read order history evidence" on storage.objects;
create policy "Post-order staff read order history evidence"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'order-evidence-photos'
  and (public.can_manage_inventory() or public.can_access_post_order_issues())
);

drop policy if exists "ebay_order_label_events_post_order_staff_select" on public.ebay_order_label_events;
create policy "ebay_order_label_events_post_order_staff_select"
on public.ebay_order_label_events
for select
to authenticated
using (public.can_manage_inventory() or public.can_access_post_order_issues());

create or replace function public.add_ebay_order_history_media_evidence(
  _order_id uuid,
  _order_line_ids uuid[] default '{}'::uuid[],
  _attachments jsonb default '[]'::jsonb,
  _note text default null,
  _evidence_type text default 'item_photo',
  _signed_by_email text default null,
  _tracking_number text default null,
  _label_provider text default null
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
  v_attachments jsonb := case
    when jsonb_typeof(coalesce(_attachments, '[]'::jsonb)) = 'array'
      then coalesce(_attachments, '[]'::jsonb)
    else '[]'::jsonb
  end;
  v_note text := nullif(btrim(coalesce(_note, '')), '');
  v_evidence_type text := coalesce(nullif(btrim(coalesce(_evidence_type, '')), ''), 'item_photo');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
  v_tracking_number text := nullif(btrim(coalesce(_tracking_number, '')), '');
  v_label_provider text := nullif(btrim(coalesce(_label_provider, '')), '');
  v_attachment_count integer := 0;
  v_existing_tracking text[] := '{}'::text[];
  v_tracking_numbers text[] := '{}'::text[];
  v_lookup_keys text[] := '{}'::text[];
  v_external_label_evidence jsonb := '[]'::jsonb;
  v_label_patch jsonb := '{}'::jsonb;
  v_first_label_attachment jsonb := null;
  v_label_bucket text := 'order-evidence-photos';
  v_label_path text := null;
  v_attachment_paths text[] := '{}'::text[];
begin
  if not (public.can_manage_inventory() or public.can_access_post_order_issues()) then
    raise exception 'Not allowed to add order history evidence' using errcode = '42501';
  end if;

  v_attachment_count := jsonb_array_length(v_attachments);

  if v_attachment_count = 0 and v_tracking_number is null then
    raise exception 'At least one evidence file or tracking number is required' using errcode = '22023';
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

  select coalesce(array_agg(distinct nullif(btrim(value), '')), '{}'::text[])
    into v_existing_tracking
  from (
    select v_order.label_metadata ->> 'trackingNumber' as value
    union all
    select v_order.label_metadata ->> 'shippingBarcodeNumber'
    union all
    select jsonb_array_elements_text(
      case when jsonb_typeof(v_order.label_metadata -> 'trackingNumbers') = 'array'
        then v_order.label_metadata -> 'trackingNumbers'
        else '[]'::jsonb
      end
    )
    union all
    select jsonb_array_elements_text(
      case when jsonb_typeof(v_order.label_metadata -> 'shippingBarcodeNumbers') = 'array'
        then v_order.label_metadata -> 'shippingBarcodeNumbers'
        else '[]'::jsonb
      end
    )
  ) existing(value)
  where nullif(btrim(value), '') is not null;

  select coalesce(array_agg(distinct nullif(btrim(value), '')), '{}'::text[])
    into v_tracking_numbers
  from unnest(v_existing_tracking || coalesce(array[v_tracking_number], '{}'::text[])) as entry(value)
  where nullif(btrim(value), '') is not null;

  select coalesce(array_agg(distinct nullif(btrim(value), '')), '{}'::text[])
    into v_lookup_keys
  from (
    select v_order.order_number as value
    union all
    select v_order.ebay_shipment_id
    union all
    select v_label_provider
    union all
    select unnest(v_tracking_numbers)
    union all
    select jsonb_array_elements_text(
      case when jsonb_typeof(v_order.label_metadata -> 'lookupKeys') = 'array'
        then v_order.label_metadata -> 'lookupKeys'
        else '[]'::jsonb
      end
    )
  ) keys(value)
  where nullif(btrim(value), '') is not null;

  select attachment
    into v_first_label_attachment
  from jsonb_array_elements(v_attachments) as attachment
  where nullif(btrim(coalesce(attachment ->> 'path', attachment ->> 'storage_path', '')), '') is not null
    and (
      v_tracking_number is not null
      or v_label_provider is not null
      or v_evidence_type in ('label_pdf', 'label_screenshot', 'tracking_update')
      or coalesce(attachment ->> 'media_type', attachment ->> 'mediaType', '') = 'pdf'
      or lower(coalesce(attachment ->> 'mime_type', attachment ->> 'mimeType', '')) = 'application/pdf'
    )
  limit 1;

  if v_first_label_attachment is not null then
    v_label_bucket := coalesce(
      nullif(btrim(v_first_label_attachment ->> 'bucket'), ''),
      nullif(btrim(v_first_label_attachment ->> 'storage_bucket'), ''),
      'order-evidence-photos'
    );
    v_label_path := coalesce(
      nullif(btrim(v_first_label_attachment ->> 'path'), ''),
      nullif(btrim(v_first_label_attachment ->> 'storage_path'), '')
    );
  end if;

  select coalesce(array_agg(distinct nullif(btrim(value), '')), '{}'::text[])
    into v_attachment_paths
  from jsonb_array_elements(v_attachments) as attachment
  cross join lateral (
    values (
      coalesce(attachment ->> 'path', attachment ->> 'storage_path')
    )
  ) as paths(value)
  where nullif(btrim(value), '') is not null;

  v_external_label_evidence := case
    when jsonb_typeof(v_order.label_metadata -> 'externalLabelEvidence') = 'array'
      then v_order.label_metadata -> 'externalLabelEvidence'
    else '[]'::jsonb
  end;

  if v_tracking_number is not null
     or v_label_provider is not null
     or v_evidence_type in ('label_pdf', 'label_screenshot', 'tracking_update')
     or v_label_path is not null then
    v_label_patch := jsonb_build_object(
      'trackingNumber', coalesce(v_tracking_numbers[1], ''),
      'trackingNumbers', to_jsonb(v_tracking_numbers),
      'shippingBarcodeNumber', coalesce(v_tracking_numbers[1], ''),
      'shippingBarcodeNumbers', to_jsonb(v_tracking_numbers),
      'lookupKeys', to_jsonb(v_lookup_keys),
      'externalLabelProvider', coalesce(v_label_provider, v_order.label_metadata ->> 'externalLabelProvider', ''),
      'externalLabelEvidence', v_external_label_evidence || jsonb_build_array(jsonb_build_object(
        'source', 'order_history_media_evidence',
        'evidence_type', v_evidence_type,
        'tracking_number', v_tracking_number,
        'label_provider', v_label_provider,
        'bucket', v_label_bucket,
        'path', v_label_path,
        'attachment_paths', to_jsonb(v_attachment_paths),
        'recorded_at', now(),
        'recorded_by_email', v_signed_email
      ))
    );

    update public.ebay_orders
    set label_metadata = coalesce(label_metadata, '{}'::jsonb) || v_label_patch,
        tracking_number = coalesce(nullif(tracking_number, ''), v_tracking_number),
        updated_at = now()
    where id = v_order.id;

    v_order.label_metadata := coalesce(v_order.label_metadata, '{}'::jsonb) || v_label_patch;
    v_order.tracking_number := coalesce(nullif(v_order.tracking_number, ''), v_tracking_number);
  end if;

  if v_label_path is not null then
    insert into public.ebay_order_label_events (
      action,
      order_ids,
      order_line_ids,
      order_numbers,
      shipment_id,
      label_storage_bucket,
      label_file_path,
      previous_label_file_paths,
      label_metadata,
      signed_by,
      signed_by_email,
      source
    )
    values (
      'extra_label',
      array[v_order.id],
      v_line_ids,
      array[v_order.order_number],
      v_tracking_number,
      v_label_bucket,
      v_label_path,
      '{}'::text[],
      coalesce(v_label_patch, '{}'::jsonb) || jsonb_build_object(
        'source', 'order_history_media_evidence',
        'evidence_type', v_evidence_type,
        'trackingNumber', coalesce(v_tracking_numbers[1], ''),
        'trackingNumbers', to_jsonb(v_tracking_numbers),
        'shippingBarcodeNumber', coalesce(v_tracking_numbers[1], ''),
        'shippingBarcodeNumbers', to_jsonb(v_tracking_numbers),
        'lookupKeys', to_jsonb(v_lookup_keys),
        'evidence_photos', v_attachments,
        'notes', coalesce(v_note, 'External shipping evidence added after closeout.')
      ),
      auth.uid(),
      v_signed_email,
      'order_history'
    );
  end if;

  select *
    into v_task
  from public.ebay_order_tasks
  where order_id = v_order.id
    and metadata ->> 'source' = 'order_history_extra_photo'
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
        latest_photo_count = coalesce(latest_photo_count, 0) + v_attachment_count,
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
          'source', 'order_history_extra_photo',
          'media_source', 'order_history_media_evidence',
          'hidden_from_task_board', true,
          'last_extra_photo_at', now(),
          'last_evidence_type', v_evidence_type,
          'last_tracking_number', v_tracking_number,
          'last_label_provider', v_label_provider
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
      concat('Order history evidence - ', coalesce(v_order.order_number, 'eBay order')),
      'Hidden order-history evidence container',
      'resolved',
      'low',
      v_note,
      v_attachment_count,
      now(),
      auth.uid(),
      v_signed_email,
      'Post-close order-history evidence container.',
      auth.uid(),
      v_signed_email,
      jsonb_build_object(
        'source', 'order_history_extra_photo',
        'media_source', 'order_history_media_evidence',
        'hidden_from_task_board', true,
        'created_from', 'ebay_order_history',
        'order_number', v_order.order_number,
        'order_status', v_order.status,
        'buyer_username', v_order.buyer_username,
        'buyer_name', v_order.buyer_name,
        'line_count', cardinality(v_line_ids),
        'order_total_price', v_order.total_price,
        'order_net_payout', v_order.net_payout,
        'tracking_number', v_tracking_number,
        'label_provider', v_label_provider
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
    v_attachments,
    auth.uid(),
    v_signed_email,
    jsonb_build_object(
      'source', 'order_history_media_evidence',
      'proof_type', v_evidence_type,
      'evidence_type', v_evidence_type,
      'order_line_ids', to_jsonb(v_line_ids),
      'order_number', v_order.order_number,
      'buyer_username', v_order.buyer_username,
      'buyer_name', v_order.buyer_name,
      'attachment_count', v_attachment_count,
      'photo_count', v_attachment_count,
      'tracking_number', v_tracking_number,
      'label_provider', v_label_provider,
      'label_metadata_patch', v_label_patch
    )
  )
  returning * into v_event;

  return v_event;
end;
$$;

revoke all on function public.add_ebay_order_history_media_evidence(
  uuid,
  uuid[],
  jsonb,
  text,
  text,
  text,
  text,
  text
) from public;

grant execute on function public.add_ebay_order_history_media_evidence(
  uuid,
  uuid[],
  jsonb,
  text,
  text,
  text,
  text,
  text
) to authenticated;
