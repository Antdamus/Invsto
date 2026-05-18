-- Allow active inventory workers to upload eBay order CSV reports.
-- Admin-only closeout/editing stays separate; this only opens the import tables
-- used by pending-orders.js.

grant insert on table public.ebay_orders to authenticated;
grant insert on table public.ebay_order_lines to authenticated;
grant update(status) on table public.ebay_orders to authenticated;
grant delete on table public.ebay_orders to authenticated;

drop policy if exists "ebay_orders_inventory_staff_import" on public.ebay_orders;
create policy "ebay_orders_inventory_staff_import"
on public.ebay_orders
for insert
to authenticated
with check (
  public.can_manage_inventory()
  and imported_by = auth.uid()
);

drop policy if exists "ebay_order_lines_inventory_staff_import" on public.ebay_order_lines;
create policy "ebay_order_lines_inventory_staff_import"
on public.ebay_order_lines
for insert
to authenticated
with check (
  public.can_manage_inventory()
  and exists (
    select 1
    from public.ebay_orders o
    where o.id = order_id
  )
);

drop policy if exists "ebay_orders_inventory_staff_import_status_update" on public.ebay_orders;
create policy "ebay_orders_inventory_staff_import_status_update"
on public.ebay_orders
for update
to authenticated
using (public.can_manage_inventory())
with check (public.can_manage_inventory());

drop policy if exists "ebay_orders_inventory_staff_import_rollback" on public.ebay_orders;
create policy "ebay_orders_inventory_staff_import_rollback"
on public.ebay_orders
for delete
to authenticated
using (
  public.can_manage_inventory()
  and imported_by = auth.uid()
  and raw_payload->>'source' = 'ebay_orders_report_csv'
);
