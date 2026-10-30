-- Evidence for buyer show maps. Kept separate from operational orders and capture queues.
create table public.ebay_show_catalog (
  event_id text primary key,
  title text not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  source_url text not null,
  captured_at timestamptz not null default now()
);
create table public.ebay_show_listing_evidence (
  event_id text not null references public.ebay_show_catalog(event_id),
  item_number text not null,
  ordinal integer,
  listing_status text,
  captured_at timestamptz not null default now(),
  primary key(event_id,item_number)
);
create index on public.ebay_show_listing_evidence(item_number);
create table public.ebay_order_map_history (
  order_number text primary key,
  buyer_username text not null,
  purchased_at timestamptz,
  evidence jsonb not null,
  captured_at timestamptz not null default now()
);
create index on public.ebay_order_map_history(lower(buyer_username));
create table public.ebay_order_map_capture_runs (
  id uuid primary key default gen_random_uuid(),
  since_at timestamptz not null,
  until_at timestamptz not null default now(),
  window_start timestamptz not null,
  page_offset integer not null default 0,
  order_count integer not null default 0,
  status text not null default 'running' check(status in ('running','complete')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
do $$ declare t text; begin
  foreach t in array array['ebay_show_catalog','ebay_show_listing_evidence','ebay_order_map_history','ebay_order_map_capture_runs'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon, authenticated',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('grant all on public.%I to service_role',t);
    execute format('create policy inventory_read on public.%I for select to authenticated using (public.can_manage_inventory())',t);
  end loop;
end $$;
create or replace function public.ebay_order_map_earliest_pending() returns timestamptz
language sql stable security definer set search_path=public as $$
  select min(o.sale_date::timestamptz) from public.ebay_orders o
  join public.ebay_order_lines l on l.order_id=o.id
  where l.line_status in ('pending','partially_fulfilled');
$$;
revoke all on function public.ebay_order_map_earliest_pending() from public, anon, authenticated;
grant execute on function public.ebay_order_map_earliest_pending() to service_role;
