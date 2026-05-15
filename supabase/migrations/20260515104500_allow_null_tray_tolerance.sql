-- The UI supports "No tray weight limit"; represent that as NULL.
alter table public.locations
  alter column tray_weight_tolerance_grams drop not null;
