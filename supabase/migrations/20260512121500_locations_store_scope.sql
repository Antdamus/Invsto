alter table public.locations
  add column if not exists store_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'locations_store_id_fkey'
  ) then
    alter table public.locations
      add constraint locations_store_id_fkey
      foreign key (store_id)
      references public.store_locations(id)
      on delete set null;
  end if;
end $$;

create index if not exists idx_locations_store_id
  on public.locations (store_id);
