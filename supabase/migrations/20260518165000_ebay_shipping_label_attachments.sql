-- Private eBay shipping label PDFs captured by the browser extension.

insert into storage.buckets (id, name, public)
values ('ebay-labels', 'ebay-labels', false)
on conflict (id) do nothing;

alter table public.ebay_orders
  add column if not exists ebay_shipment_id text,
  add column if not exists label_status text not null default 'awaiting_label'
    check (label_status in ('awaiting_label', 'label_uploaded', 'ready_to_confirm', 'completed')),
  add column if not exists label_storage_bucket text not null default 'ebay-labels',
  add column if not exists label_file_path text,
  add column if not exists label_uploaded_at timestamptz,
  add column if not exists label_uploaded_by uuid references auth.users(id) on delete set null,
  add column if not exists label_metadata jsonb not null default '{}'::jsonb;

create index if not exists ebay_orders_label_status_idx
  on public.ebay_orders(label_status, label_uploaded_at desc);

drop policy if exists "Inventory staff upload ebay labels" on storage.objects;
create policy "Inventory staff upload ebay labels"
on storage.objects
for insert
to authenticated
with check (bucket_id = 'ebay-labels' and public.can_manage_inventory());

drop policy if exists "Inventory staff update ebay labels" on storage.objects;
create policy "Inventory staff update ebay labels"
on storage.objects
for update
to authenticated
using (bucket_id = 'ebay-labels' and public.can_manage_inventory())
with check (bucket_id = 'ebay-labels' and public.can_manage_inventory());

drop policy if exists "Inventory staff read ebay labels" on storage.objects;
create policy "Inventory staff read ebay labels"
on storage.objects
for select
to authenticated
using (bucket_id = 'ebay-labels' and public.can_manage_inventory());

drop policy if exists "Admins delete ebay labels" on storage.objects;
create policy "Admins delete ebay labels"
on storage.objects
for delete
to authenticated
using (bucket_id = 'ebay-labels' and public.is_admin());

grant update (
  ebay_shipment_id,
  label_status,
  label_storage_bucket,
  label_file_path,
  label_uploaded_at,
  label_uploaded_by,
  label_metadata
) on table public.ebay_orders to authenticated;

drop policy if exists "ebay_orders_inventory_staff_label_update" on public.ebay_orders;
create policy "ebay_orders_inventory_staff_label_update"
on public.ebay_orders
for update
to authenticated
using (public.can_manage_inventory())
with check (public.can_manage_inventory());
