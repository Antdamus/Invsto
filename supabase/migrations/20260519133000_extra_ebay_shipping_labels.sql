alter table public.ebay_order_label_events
  drop constraint if exists ebay_order_label_events_action_check;

alter table public.ebay_order_label_events
  add constraint ebay_order_label_events_action_check
  check (action in ('attached', 'replaced', 'tracking_backfilled', 'extra_label'));

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
