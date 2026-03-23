create table public.storefront_content (
  channel text not null,
  slot text not null,
  type text not null check (type in ('text','image')),
  value text not null,
  status text not null check (status in ('draft','published')),
  updated_at timestamptz not null default now(),
  primary key (channel, slot, status)
);
