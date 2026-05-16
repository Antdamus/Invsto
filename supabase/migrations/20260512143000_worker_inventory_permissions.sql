-- Allow active workers to create item records and add inventory.
-- This keeps destructive/admin-only actions gated while opening the intake flows.

create or replace function public.can_manage_inventory()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.employees e
    where e.user_id = auth.uid()
      and e.active is distinct from false
      and e.role in ('admin', 'manager', 'employee')
  );
$$;
revoke all on function public.can_manage_inventory() from public;
grant execute on function public.can_manage_inventory() to authenticated;
drop policy if exists "Allow select for admins only" on public.item_types;
drop policy if exists "Allow insert for admins" on public.item_types;
drop policy if exists "Allow update for admin" on public.item_types;
drop policy if exists "Allow delete for admin" on public.item_types;
create policy "item_types_select_inventory_staff"
on public.item_types
for select
to authenticated
using (public.can_manage_inventory());
create policy "item_types_insert_inventory_staff"
on public.item_types
for insert
to authenticated
with check (public.can_manage_inventory());
create policy "item_types_update_admin"
on public.item_types
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());
create policy "item_types_delete_admin"
on public.item_types
for delete
to authenticated
using (public.is_admin());
drop policy if exists "bulk_batches_insert_admin_only" on public.bulk_batches;
create policy "bulk_batches_insert_inventory_staff"
on public.bulk_batches
for insert
to authenticated
with check (public.can_manage_inventory() and created_by = auth.uid());
drop policy if exists "Admin label upload dymo" on storage.objects;
drop policy if exists "Admin label upload photos" on storage.objects;
drop policy if exists "Admin location-assets upload photos" on storage.objects;
drop policy if exists "Read labels via signed URL dymo" on storage.objects;
drop policy if exists "Read labels via signed URL photos" on storage.objects;
drop policy if exists "Read location-assets via signed URL photos" on storage.objects;
create policy "Inventory staff upload dymo labels"
on storage.objects
for insert
to authenticated
with check (bucket_id = 'dymo-labels' and public.can_manage_inventory());
create policy "Inventory staff read dymo labels"
on storage.objects
for select
to authenticated
using (bucket_id = 'dymo-labels' and public.can_manage_inventory());
create policy "Inventory staff upload item photos"
on storage.objects
for insert
to authenticated
with check (bucket_id = 'photos' and public.can_manage_inventory());
create policy "Inventory staff read item photos"
on storage.objects
for select
to authenticated
using (bucket_id = 'photos' and public.can_manage_inventory());
create policy "Inventory staff upload location assets"
on storage.objects
for insert
to authenticated
with check (bucket_id = 'location-assets' and public.can_manage_inventory());
create policy "Inventory staff read location assets"
on storage.objects
for select
to authenticated
using (bucket_id = 'location-assets' and public.can_manage_inventory());
