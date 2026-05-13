-- Worker-facing stock/tray operations.
-- Workers can manage tray movement and item photos without gaining access to admin-only item edits.

create or replace function public.append_item_photos(_item_id uuid, _photo_paths text[])
returns text[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  next_photos text[];
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to manage inventory photos' using errcode = '42501';
  end if;

  if _item_id is null then
    raise exception 'Item id is required' using errcode = '22023';
  end if;

  update public.item_types it
  set photos = (
    select coalesce(array_agg(photo_path order by first_seen), '{}'::text[])
    from (
      select photo_path, min(ord) as first_seen
      from unnest(coalesce(it.photos, '{}'::text[]) || coalesce(_photo_paths, '{}'::text[]))
        with ordinality as source(photo_path, ord)
      where nullif(btrim(photo_path), '') is not null
      group by photo_path
    ) unique_photos
  )
  where it.id = _item_id
  returning it.photos into next_photos;

  if not found then
    raise exception 'Item not found' using errcode = 'P0002';
  end if;

  return coalesce(next_photos, '{}'::text[]);
end;
$$;

create or replace function public.remove_item_photo(_item_id uuid, _photo_path text)
returns text[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  next_photos text[];
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to manage inventory photos' using errcode = '42501';
  end if;

  if _item_id is null or nullif(btrim(coalesce(_photo_path, '')), '') is null then
    raise exception 'Item id and photo path are required' using errcode = '22023';
  end if;

  update public.item_types it
  set photos = (
    select coalesce(array_agg(photo_path order by ord), '{}'::text[])
    from unnest(coalesce(it.photos, '{}'::text[])) with ordinality as source(photo_path, ord)
    where photo_path <> _photo_path
  )
  where it.id = _item_id
  returning it.photos into next_photos;

  if not found then
    raise exception 'Item not found' using errcode = 'P0002';
  end if;

  return coalesce(next_photos, '{}'::text[]);
end;
$$;

revoke all on function public.append_item_photos(uuid, text[]) from public;
revoke all on function public.remove_item_photo(uuid, text) from public;
grant execute on function public.append_item_photos(uuid, text[]) to authenticated;
grant execute on function public.remove_item_photo(uuid, text) to authenticated;

drop policy if exists "Inventory staff delete item photos" on storage.objects;
create policy "Inventory staff delete item photos"
on storage.objects
for delete
to authenticated
using (bucket_id = 'photos' and public.can_manage_inventory());

drop policy if exists "photo_deletion_log_inventory_select" on public.photo_deletion_log;
drop policy if exists "photo_deletion_log_inventory_insert" on public.photo_deletion_log;
drop policy if exists "photo_deletion_log_inventory_update" on public.photo_deletion_log;

create policy "photo_deletion_log_inventory_select"
on public.photo_deletion_log
for select
to authenticated
using (public.can_manage_inventory());

create policy "photo_deletion_log_inventory_insert"
on public.photo_deletion_log
for insert
to authenticated
with check (
  public.can_manage_inventory()
  and (deleted_by is null or deleted_by = auth.uid())
);

create policy "photo_deletion_log_inventory_update"
on public.photo_deletion_log
for update
to authenticated
using (public.can_manage_inventory())
with check (public.can_manage_inventory());

drop policy if exists "locations_select_inventory_staff" on public.locations;
drop policy if exists "locations_insert_inventory_staff" on public.locations;
drop policy if exists "locations_update_inventory_staff" on public.locations;
drop policy if exists "locations_delete_admin" on public.locations;

create policy "locations_select_inventory_staff"
on public.locations
for select
to authenticated
using (public.can_manage_inventory());

create policy "locations_insert_inventory_staff"
on public.locations
for insert
to authenticated
with check (
  public.is_admin()
  or (public.can_manage_inventory() and is_tray is true)
);

create policy "locations_update_inventory_staff"
on public.locations
for update
to authenticated
using (
  public.is_admin()
  or (public.can_manage_inventory() and is_tray is true)
)
with check (
  public.is_admin()
  or (public.can_manage_inventory() and is_tray is true)
);

create policy "locations_delete_admin"
on public.locations
for delete
to authenticated
using (public.is_admin());
