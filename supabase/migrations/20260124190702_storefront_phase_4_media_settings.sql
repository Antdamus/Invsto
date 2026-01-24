-- ==========================================================
-- Phase 4.1: Storefront media settings (private bucket name)
-- ==========================================================

create table if not exists public.storefront_settings (
  id text primary key default 'global',
  private_photo_bucket text not null default 'photos',
  signed_url_ttl_seconds int not null default 900, -- 15 minutes
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_storefront_settings_updated_at on public.storefront_settings;
create trigger trg_storefront_settings_updated_at
before update on public.storefront_settings
for each row execute function public.set_updated_at();

insert into public.storefront_settings (id, private_photo_bucket, signed_url_ttl_seconds)
values ('global', 'photos', 900)
on conflict (id) do nothing;

-- Lock it down: staff can read, admins can write
alter table public.storefront_settings enable row level security;

revoke all on table public.storefront_settings from anon;
grant select on table public.storefront_settings to authenticated;
grant insert, update, delete on table public.storefront_settings to authenticated;

drop policy if exists "storefront_settings_read_staff" on public.storefront_settings;
create policy "storefront_settings_read_staff"
on public.storefront_settings
for select
to authenticated
using (
  exists (
    select 1 from public.employees e
    where e.user_id = auth.uid()
      and e.active = true
  )
);

drop policy if exists "storefront_settings_write_admin" on public.storefront_settings;
create policy "storefront_settings_write_admin"
on public.storefront_settings
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

