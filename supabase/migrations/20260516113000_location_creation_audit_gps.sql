-- Persist location/container/tray creation metadata directly on the location record.
-- The general inventory_change_log still captures full before/after audit details.

alter table public.locations
  add column if not exists created_by uuid references auth.users(id) on delete set null,
  add column if not exists created_by_email text,
  add column if not exists creation_latitude numeric,
  add column if not exists creation_longitude numeric,
  add column if not exists creation_accuracy_m numeric,
  add column if not exists creation_gps_captured_at timestamptz,
  add column if not exists creation_gps_status text;
create index if not exists locations_created_by_idx
  on public.locations(created_by, created_at desc);
create index if not exists locations_creation_gps_idx
  on public.locations(creation_latitude, creation_longitude)
  where creation_latitude is not null
    and creation_longitude is not null;
create or replace function public.set_location_creation_metadata()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_jwt_email text;
begin
  begin
    v_jwt_email := current_setting('request.jwt.claims', true)::jsonb ->> 'email';
  exception when others then
    v_jwt_email := null;
  end;

  new.created_by := coalesce(auth.uid(), new.created_by);
  new.created_by_email := coalesce(v_jwt_email, new.created_by_email);
  new.creation_gps_status := coalesce(
    nullif(btrim(new.creation_gps_status), ''),
    case
      when new.creation_latitude is not null and new.creation_longitude is not null then 'captured'
      else 'not_recorded'
    end
  );

  return new;
end;
$$;
drop trigger if exists trg_locations_creation_metadata on public.locations;
create trigger trg_locations_creation_metadata
before insert on public.locations
for each row
execute function public.set_location_creation_metadata();
