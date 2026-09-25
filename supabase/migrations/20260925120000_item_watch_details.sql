-- Preserve watch composition and modifications without assigning a single metal/purity.
alter table public.item_types
  add column if not exists watch_details jsonb;

alter table public.item_types
  add constraint item_types_watch_details_object_check
  check (watch_details is null or jsonb_typeof(watch_details) = 'object');

comment on column public.item_types.watch_details is
  'Watch intake: name, model/reference, materials by component, and modifications. NULL for standard jewelry.';
