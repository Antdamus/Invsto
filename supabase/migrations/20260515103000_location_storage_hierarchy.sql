-- Storage hierarchy for working trays and deeper bag/container inventory.
-- A stock-holding "location" can now be:
--   storage_location: fixed place such as a table, vault, shelf, case, or safe.
--   container: bag/container stored inside a fixed place.
--   tray: mobile working inventory tray.

alter table public.locations
  add column if not exists location_role text,
  add column if not exists parent_location_id uuid,
  add column if not exists container_kind text;

update public.locations
set location_role = case
  when is_tray is true then 'tray'
  when parent_location_id is not null then 'container'
  when nullif(btrim(coalesce(location_role, '')), '') is not null then location_role
  else 'storage_location'
end
where location_role is null
   or nullif(btrim(coalesce(location_role, '')), '') is null;

alter table public.locations
  alter column location_role set default 'storage_location';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'locations_location_role_check'
  ) then
    alter table public.locations
      add constraint locations_location_role_check
      check (location_role in ('storage_location', 'container', 'tray'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'locations_parent_location_id_fkey'
  ) then
    alter table public.locations
      add constraint locations_parent_location_id_fkey
      foreign key (parent_location_id)
      references public.locations(id)
      on delete set null;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'locations_parent_not_self_check'
  ) then
    alter table public.locations
      add constraint locations_parent_not_self_check
      check (parent_location_id is null or parent_location_id <> id);
  end if;
end $$;

create index if not exists idx_locations_location_role
  on public.locations(location_role);

create index if not exists idx_locations_parent_location
  on public.locations(parent_location_id);

update public.locations
set location_role = 'tray'
where is_tray is true
  and location_role <> 'tray';

update public.locations
set location_role = 'container'
where parent_location_id is not null
  and coalesce(is_tray, false) is false
  and location_role <> 'container';

drop policy if exists "locations_insert_inventory_staff" on public.locations;
drop policy if exists "locations_update_inventory_staff" on public.locations;

create policy "locations_insert_inventory_staff"
on public.locations
for insert
to authenticated
with check (
  public.is_admin()
  or (
    public.can_manage_inventory()
    and (
      is_tray is true
      or location_role in ('tray', 'container')
    )
  )
);

create policy "locations_update_inventory_staff"
on public.locations
for update
to authenticated
using (
  public.is_admin()
  or (
    public.can_manage_inventory()
    and (
      is_tray is true
      or location_role in ('tray', 'container')
    )
  )
)
with check (
  public.is_admin()
  or (
    public.can_manage_inventory()
    and (
      is_tray is true
      or location_role in ('tray', 'container')
    )
  )
);
