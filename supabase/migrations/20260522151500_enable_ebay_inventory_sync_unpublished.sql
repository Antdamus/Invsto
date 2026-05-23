update public.ebay_inventory_settings
set
  enabled = true,
  publish_enabled = false,
  updated_at = now()
where id = 'default';
