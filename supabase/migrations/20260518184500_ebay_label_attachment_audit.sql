-- Immutable audit events for eBay shipping label attachments and replacements.

create table if not exists public.ebay_order_label_events (
  id uuid primary key default gen_random_uuid(),
  action text not null check (action in ('attached', 'replaced')),
  order_ids uuid[] not null default '{}'::uuid[],
  order_line_ids uuid[] not null default '{}'::uuid[],
  order_numbers text[] not null default '{}'::text[],
  shipment_id text,
  label_storage_bucket text not null default 'ebay-labels',
  label_file_path text not null,
  previous_label_file_paths text[] not null default '{}'::text[],
  label_metadata jsonb not null default '{}'::jsonb,
  signed_by uuid references auth.users(id) on delete set null,
  signed_by_email text,
  source text not null default 'extension',
  created_at timestamptz not null default now()
);

alter table public.ebay_order_label_events enable row level security;

drop policy if exists "ebay_order_label_events_inventory_staff_select" on public.ebay_order_label_events;
create policy "ebay_order_label_events_inventory_staff_select"
on public.ebay_order_label_events
for select
to authenticated
using (public.can_manage_inventory());

drop policy if exists "ebay_order_label_events_inventory_staff_insert" on public.ebay_order_label_events;
create policy "ebay_order_label_events_inventory_staff_insert"
on public.ebay_order_label_events
for insert
to authenticated
with check (public.can_manage_inventory());

grant select, insert on table public.ebay_order_label_events to authenticated;

create index if not exists ebay_order_label_events_created_at_idx
  on public.ebay_order_label_events(created_at desc);

create index if not exists ebay_order_label_events_order_numbers_idx
  on public.ebay_order_label_events using gin(order_numbers);

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
