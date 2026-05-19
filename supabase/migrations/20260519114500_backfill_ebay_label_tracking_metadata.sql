alter table public.ebay_order_label_events
  drop constraint if exists ebay_order_label_events_action_check;

alter table public.ebay_order_label_events
  add constraint ebay_order_label_events_action_check
  check (action in ('attached', 'replaced', 'tracking_backfilled'));

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

  update public.ebay_orders
  set label_metadata = coalesce(label_metadata, '{}'::jsonb) || v_patch,
      updated_at = now()
  where id = any(v_order_ids)
    and label_file_path = v_path;

  get diagnostics v_updated = row_count;

  update public.ebay_order_label_events
  set label_metadata = coalesce(label_metadata, '{}'::jsonb) || v_patch
  where label_file_path = v_path
    and order_ids && v_order_ids;

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
    '{}'::uuid[],
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
