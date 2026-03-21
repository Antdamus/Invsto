insert into public.capture_stations (
  name,
  active
)
select
  'Front Desk Station',
  true
where not exists (
  select 1
  from public.capture_stations
  where name = 'Front Desk Station'
);
