-- Let active inventory workers search completed eBay closeout proof and evidence photos.
-- Reversal events and reversal RPCs remain admin-only.

grant select on table public.ebay_order_admin_events to authenticated;

drop policy if exists "ebay_order_admin_events_inventory_staff_select" on public.ebay_order_admin_events;
create policy "ebay_order_admin_events_inventory_staff_select"
on public.ebay_order_admin_events
for select
to authenticated
using (public.can_manage_inventory());
