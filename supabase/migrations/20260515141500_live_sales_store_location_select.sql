-- Live sales and pending packing need inventory staff to read active store names.
-- Some remote schemas have RLS enabled on store_locations without a staff
-- select policy, which makes store dropdowns render empty.

drop policy if exists "store_locations_inventory_staff_select" on public.store_locations;
create policy "store_locations_inventory_staff_select"
on public.store_locations
for select
to authenticated
using (public.can_manage_inventory());
grant select on table public.store_locations to authenticated;
