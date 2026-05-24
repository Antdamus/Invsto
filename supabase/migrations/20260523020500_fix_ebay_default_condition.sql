alter table public.ebay_inventory_settings
  alter column default_condition set default 'NEW';

update public.ebay_inventory_settings
set
  default_condition = 'NEW',
  updated_at = now()
where id = 'default'
  and (
    default_condition is null
    or btrim(default_condition) = ''
    or default_condition = 'NEW_WITH_TAGS'
  );
