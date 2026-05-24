-- Let inventory staff pre-stage public eBay listing photos as items are added.
-- Paths are stable: public-ebay-photos/{item_type_id}/{source_filename}.

insert into storage.buckets (id, name, public)
values ('public-ebay-photos', 'public-ebay-photos', true)
on conflict (id) do update set public = true;

drop policy if exists "Inventory staff read public ebay photos" on storage.objects;
create policy "Inventory staff read public ebay photos"
on storage.objects
for select
using (bucket_id = 'public-ebay-photos' and public.can_manage_inventory());

drop policy if exists "Inventory staff upload public ebay photos" on storage.objects;
create policy "Inventory staff upload public ebay photos"
on storage.objects
for insert
with check (bucket_id = 'public-ebay-photos' and public.can_manage_inventory());

drop policy if exists "Inventory staff update public ebay photos" on storage.objects;
create policy "Inventory staff update public ebay photos"
on storage.objects
for update
using (bucket_id = 'public-ebay-photos' and public.can_manage_inventory())
with check (bucket_id = 'public-ebay-photos' and public.can_manage_inventory());
