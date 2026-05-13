-- Mobile tray support.
-- Trays are existing locations with barcode/DYMO assets that can move between stores.

alter table public.locations
  add column if not exists is_tray boolean not null default false,
  add column if not exists tray_status text not null default 'checked_in',
  add column if not exists tray_weight_tolerance_grams numeric(10,2) not null default 10,
  add column if not exists tray_current_store_id uuid,
  add column if not exists tray_last_checkout_weight numeric(10,2),
  add column if not exists tray_last_checkin_weight numeric(10,2),
  add column if not exists tray_last_weight_delta numeric(10,2),
  add column if not exists tray_checked_out_at timestamptz,
  add column if not exists tray_checked_out_by uuid,
  add column if not exists tray_checked_in_at timestamptz,
  add column if not exists tray_checked_in_by uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'locations_tray_status_check'
  ) then
    alter table public.locations
      add constraint locations_tray_status_check
      check (tray_status in ('checked_in', 'checked_out', 'in_transfer', 'weight_mismatch'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'locations_tray_current_store_id_fkey'
  ) then
    alter table public.locations
      add constraint locations_tray_current_store_id_fkey
      foreign key (tray_current_store_id)
      references public.store_locations(id)
      on delete set null;
  end if;
end $$;

create index if not exists idx_locations_is_tray
  on public.locations (is_tray);

create index if not exists idx_locations_tray_status
  on public.locations (tray_status)
  where is_tray is true;

create index if not exists idx_locations_tray_current_store
  on public.locations (tray_current_store_id)
  where is_tray is true;

create table if not exists public.tray_movements (
  id uuid primary key default gen_random_uuid(),
  tray_location_id uuid not null references public.locations(id) on delete cascade,
  action text not null check (action in ('check_out', 'check_in', 'transfer', 'weight_override')),
  from_store_id uuid references public.store_locations(id) on delete set null,
  to_store_id uuid references public.store_locations(id) on delete set null,
  expected_weight_grams numeric(10,2),
  actual_weight_grams numeric(10,2) not null,
  weight_delta_grams numeric(10,2),
  tolerance_grams numeric(10,2) not null default 10,
  result text not null default 'ok' check (result in ('ok', 'mismatch', 'manual_override')),
  notes text,
  performed_by uuid references auth.users(id) on delete set null,
  performed_by_email text,
  created_at timestamptz not null default now()
);

create index if not exists idx_tray_movements_tray_created
  on public.tray_movements (tray_location_id, created_at desc);

create index if not exists idx_tray_movements_result
  on public.tray_movements (result, created_at desc);

alter table public.tray_movements enable row level security;

drop policy if exists "tray_movements_select_inventory_staff" on public.tray_movements;
drop policy if exists "tray_movements_insert_inventory_staff" on public.tray_movements;
drop policy if exists "tray_movements_update_admin" on public.tray_movements;
drop policy if exists "tray_movements_delete_admin" on public.tray_movements;

create policy "tray_movements_select_inventory_staff"
on public.tray_movements
for select
to authenticated
using (public.can_manage_inventory());

create policy "tray_movements_insert_inventory_staff"
on public.tray_movements
for insert
to authenticated
with check (public.can_manage_inventory());

create policy "tray_movements_update_admin"
on public.tray_movements
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

create policy "tray_movements_delete_admin"
on public.tray_movements
for delete
to authenticated
using (public.is_admin());

grant select, insert, update, delete on table public.tray_movements to authenticated;
grant select, insert, update, delete on table public.tray_movements to service_role;

drop trigger if exists trg_locations_mobile_trays_updated_at on public.locations;
create trigger trg_locations_mobile_trays_updated_at
before update on public.locations
for each row
execute function public.set_updated_at();
