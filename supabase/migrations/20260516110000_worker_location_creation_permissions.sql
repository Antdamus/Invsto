-- Let active inventory workers create the full storage hierarchy:
-- fixed locations, nested bags/containers, and mobile trays.
-- Workers still only update operational tray/container records; fixed-location edits stay admin-facing in the UI.

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
    and coalesce(location_role, 'storage_location') in ('storage_location', 'container', 'tray')
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
      or coalesce(location_role, 'storage_location') in ('container', 'tray')
    )
  )
)
with check (
  public.is_admin()
  or (
    public.can_manage_inventory()
    and (
      is_tray is true
      or coalesce(location_role, 'storage_location') in ('container', 'tray')
    )
  )
);
