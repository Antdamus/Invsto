-- 1) Members table (keyed to auth.users.id)
create table if not exists public.members (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  name text null,

  source text not null default 'direct',     -- 'package' | 'social' | 'direct' | etc
  campaign text null,

  email_alerts boolean not null default true,
  early_access boolean not null default true,

  vip_status text not null default 'free',   -- future: 'free' | 'vip'
  vip_interest boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- 2) Keep updated_at fresh automatically
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
drop trigger if exists trg_members_set_updated_at on public.members;
create trigger trg_members_set_updated_at
before update on public.members
for each row execute function public.set_updated_at();
-- 3) RLS
alter table public.members enable row level security;
-- Read own row
drop policy if exists "members_select_own" on public.members;
create policy "members_select_own"
on public.members
for select
using (auth.uid() = id);
-- Insert own row
drop policy if exists "members_insert_own" on public.members;
create policy "members_insert_own"
on public.members
for insert
with check (auth.uid() = id);
-- Update own row
drop policy if exists "members_update_own" on public.members;
create policy "members_update_own"
on public.members
for update
using (auth.uid() = id)
with check (auth.uid() = id);
