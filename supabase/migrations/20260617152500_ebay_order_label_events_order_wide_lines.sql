-- Make shipping label audit events order-wide.
--
-- Labels and tracking metadata live on ebay_orders, so the audit event should
-- point at every line in the covered order(s), even when the UI action started
-- from one clicked/scanned line.

alter table public.ebay_order_label_events
  drop constraint if exists ebay_order_label_events_action_check;

alter table public.ebay_order_label_events
  add constraint ebay_order_label_events_action_check
  check (action in ('attached', 'replaced', 'tracking_backfilled', 'extra_label'));

with expanded as (
  select
    event_id,
    coalesce(array_agg(distinct line_id) filter (where line_id is not null), '{}'::uuid[]) as line_ids
  from (
    select
      e.id as event_id,
      unnest(coalesce(e.order_line_ids, '{}'::uuid[])) as line_id
    from public.ebay_order_label_events e

    union all

    select
      e.id as event_id,
      l.id as line_id
    from public.ebay_order_label_events e
    join public.ebay_order_lines l
      on l.order_id = any(coalesce(e.order_ids, '{}'::uuid[]))
  ) all_event_lines
  group by event_id
)
update public.ebay_order_label_events e
set order_line_ids = expanded.line_ids
from expanded
where e.id = expanded.event_id
  and e.order_line_ids is distinct from expanded.line_ids;

create or replace function public.attach_ebay_shipping_label(
  _order_ids uuid[],
  _order_line_ids uuid[] default '{}'::uuid[],
  _order_numbers text[] default '{}'::text[],
  _shipment_id text default null,
  _label_storage_bucket text default 'ebay-labels',
  _label_file_path text default null,
  _label_metadata jsonb default '{}'::jsonb,
  _signed_by_email text default null
)
returns table (
  updated_orders integer,
  audit_event_id uuid,
  action text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order_ids uuid[] := coalesce(_order_ids, '{}'::uuid[]);
  v_order_line_ids uuid[] := coalesce(_order_line_ids, '{}'::uuid[]);
  v_order_numbers text[] := coalesce(_order_numbers, '{}'::text[]);
  v_bucket text := nullif(btrim(coalesce(_label_storage_bucket, '')), '');
  v_path text := nullif(btrim(coalesce(_label_file_path, '')), '');
  v_previous_paths text[] := '{}'::text[];
  v_action text := 'attached';
  v_event_id uuid;
  v_updated integer := 0;
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to attach eBay shipping labels' using errcode = '42501';
  end if;

  if cardinality(v_order_ids) is null or cardinality(v_order_ids) = 0 then
    raise exception 'At least one eBay order is required' using errcode = '22023';
  end if;

  if v_path is null then
    raise exception 'A label file path is required' using errcode = '22023';
  end if;

  if v_bucket is null then
    v_bucket := 'ebay-labels';
  end if;

  select coalesce(array_agg(distinct expanded_line_id) filter (where expanded_line_id is not null), '{}'::uuid[])
    into v_order_line_ids
  from (
    select unnest(v_order_line_ids) as expanded_line_id
    union all
    select id as expanded_line_id
    from public.ebay_order_lines
    where order_id = any(v_order_ids)
  ) expanded_lines;

  select coalesce(array_agg(distinct label_file_path) filter (where label_file_path is not null and label_file_path <> ''), '{}'::text[])
    into v_previous_paths
  from public.ebay_orders
  where id = any(v_order_ids);

  if cardinality(v_previous_paths) is not null and cardinality(v_previous_paths) > 0 then
    v_action := 'replaced';
  end if;

  update public.ebay_orders
  set ebay_shipment_id = nullif(btrim(coalesce(_shipment_id, '')), ''),
      label_status = 'label_uploaded',
      label_storage_bucket = v_bucket,
      label_file_path = v_path,
      label_uploaded_at = now(),
      label_uploaded_by = auth.uid(),
      label_metadata = coalesce(_label_metadata, '{}'::jsonb),
      updated_at = now()
  where id = any(v_order_ids);

  get diagnostics v_updated = row_count;

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
    v_action,
    v_order_ids,
    v_order_line_ids,
    v_order_numbers,
    nullif(btrim(coalesce(_shipment_id, '')), ''),
    v_bucket,
    v_path,
    v_previous_paths,
    coalesce(_label_metadata, '{}'::jsonb),
    auth.uid(),
    nullif(btrim(coalesce(_signed_by_email, '')), ''),
    'extension'
  )
  returning id into v_event_id;

  return query select v_updated, v_event_id, v_action;
end;
$$;

grant execute on function public.attach_ebay_shipping_label(
  uuid[],
  uuid[],
  text[],
  text,
  text,
  text,
  jsonb,
  text
) to authenticated;

create or replace function public.backfill_ebay_label_tracking_metadata(
  _order_ids uuid[],
  _label_file_path text,
  _label_metadata_patch jsonb default '{}'::jsonb,
  _signed_by_email text default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order_ids uuid[] := coalesce(_order_ids, '{}'::uuid[]);
  v_path text := nullif(btrim(coalesce(_label_file_path, '')), '');
  v_patch jsonb := coalesce(_label_metadata_patch, '{}'::jsonb);
  v_order_numbers text[] := '{}'::text[];
  v_order_line_ids uuid[] := '{}'::uuid[];
  v_updated integer := 0;
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to backfill eBay label tracking metadata' using errcode = '42501';
  end if;

  if cardinality(v_order_ids) is null or cardinality(v_order_ids) = 0 then
    raise exception 'At least one eBay order is required' using errcode = '22023';
  end if;

  if v_path is null then
    raise exception 'A label file path is required' using errcode = '22023';
  end if;

  if v_patch = '{}'::jsonb then
    raise exception 'Tracking metadata is required' using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct order_number), '{}'::text[])
    into v_order_numbers
  from public.ebay_orders
  where id = any(v_order_ids);

  select coalesce(array_agg(distinct id), '{}'::uuid[])
    into v_order_line_ids
  from public.ebay_order_lines
  where order_id = any(v_order_ids);

  update public.ebay_orders
  set label_metadata = coalesce(label_metadata, '{}'::jsonb) || v_patch,
      updated_at = now()
  where id = any(v_order_ids)
    and label_file_path = v_path;

  get diagnostics v_updated = row_count;

  update public.ebay_order_label_events e
  set label_metadata = coalesce(label_metadata, '{}'::jsonb) || v_patch,
      order_line_ids = (
        select coalesce(array_agg(distinct expanded_line_id) filter (where expanded_line_id is not null), '{}'::uuid[])
        from (
          select unnest(coalesce(e.order_line_ids, '{}'::uuid[])) as expanded_line_id
          union all
          select unnest(v_order_line_ids) as expanded_line_id
        ) expanded_lines
      )
  where e.label_file_path = v_path
    and e.order_ids && v_order_ids;

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
    'tracking_backfilled',
    v_order_ids,
    v_order_line_ids,
    v_order_numbers,
    nullif(btrim(coalesce(v_patch ->> 'shipmentId', '')), ''),
    'ebay-labels',
    v_path,
    '{}'::text[],
    v_patch,
    auth.uid(),
    nullif(btrim(coalesce(_signed_by_email, '')), ''),
    'stored-label-pdf-backfill'
  );

  return v_updated;
end;
$$;

grant execute on function public.backfill_ebay_label_tracking_metadata(
  uuid[],
  text,
  jsonb,
  text
) to authenticated;

create or replace function public.attach_ebay_extra_shipping_label(
  _order_ids uuid[],
  _order_line_ids uuid[] default '{}'::uuid[],
  _order_numbers text[] default '{}'::text[],
  _shipment_id text default null,
  _label_storage_bucket text default 'ebay-labels',
  _label_file_path text default null,
  _label_metadata jsonb default '{}'::jsonb,
  _evidence_photos jsonb default '[]'::jsonb,
  _notes text default null,
  _signed_by_email text default null
)
returns table (
  audit_event_id uuid,
  action text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order_ids uuid[] := coalesce(_order_ids, '{}'::uuid[]);
  v_order_line_ids uuid[] := coalesce(_order_line_ids, '{}'::uuid[]);
  v_order_numbers text[] := coalesce(_order_numbers, '{}'::text[]);
  v_bucket text := nullif(btrim(coalesce(_label_storage_bucket, '')), '');
  v_path text := nullif(btrim(coalesce(_label_file_path, '')), '');
  v_previous_paths text[] := '{}'::text[];
  v_event_id uuid;
  v_evidence_photos jsonb := case
    when jsonb_typeof(coalesce(_evidence_photos, '[]'::jsonb)) = 'array'
      then coalesce(_evidence_photos, '[]'::jsonb)
    else '[]'::jsonb
  end;
  v_notes text := nullif(btrim(coalesce(_notes, '')), '');
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to attach extra eBay shipping labels' using errcode = '42501';
  end if;

  if cardinality(v_order_ids) is null or cardinality(v_order_ids) = 0 then
    raise exception 'At least one eBay order is required' using errcode = '22023';
  end if;

  if v_path is null then
    raise exception 'A label file path is required' using errcode = '22023';
  end if;

  if v_bucket is null then
    v_bucket := 'ebay-labels';
  end if;

  if jsonb_array_length(v_evidence_photos) = 0 then
    raise exception 'A photo of the forgotten items is required before adding an extra label' using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct expanded_line_id) filter (where expanded_line_id is not null), '{}'::uuid[])
    into v_order_line_ids
  from (
    select unnest(v_order_line_ids) as expanded_line_id
    union all
    select id as expanded_line_id
    from public.ebay_order_lines
    where order_id = any(v_order_ids)
  ) expanded_lines;

  select coalesce(array_agg(distinct label_file_path) filter (where label_file_path is not null and label_file_path <> ''), '{}'::text[])
    into v_previous_paths
  from public.ebay_orders
  where id = any(v_order_ids);

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
    v_order_ids,
    v_order_line_ids,
    v_order_numbers,
    nullif(btrim(coalesce(_shipment_id, '')), ''),
    v_bucket,
    v_path,
    v_previous_paths,
    coalesce(_label_metadata, '{}'::jsonb) || jsonb_build_object(
      'extraLabelReason', 'forgotten_items_after_closeout',
      'requiresMissingItemsPhoto', true,
      'evidence_photos', v_evidence_photos,
      'notes', coalesce(v_notes, 'Extra shipping label added because items were forgotten after the order was closed.')
    ),
    auth.uid(),
    nullif(btrim(coalesce(_signed_by_email, '')), ''),
    'extension'
  )
  returning id into v_event_id;

  audit_event_id := v_event_id;
  action := 'extra_label';
  return next;
end;
$$;

grant execute on function public.attach_ebay_extra_shipping_label(
  uuid[],
  uuid[],
  text[],
  text,
  text,
  text,
  jsonb,
  jsonb,
  text,
  text
) to authenticated;
