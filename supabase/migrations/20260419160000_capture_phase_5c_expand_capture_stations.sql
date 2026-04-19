with desired_stations (name, active) as (
  values
    ('Front Desk 1', true),
    ('Front Desk 2', true),
    ('Front Desk 3', true),
    ('Back Room 1', true),
    ('Back Room 2', true)
)
insert into public.capture_stations (
  name,
  active
)
select
  ds.name,
  ds.active
from desired_stations ds
where not exists (
  select 1
  from public.capture_stations existing
  where existing.name = ds.name
);
