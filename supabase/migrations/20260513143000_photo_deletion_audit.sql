-- Audit trail for password-confirmed item photo removals.

create table if not exists public.photo_deletion_log (
  id uuid primary key default gen_random_uuid(),
  item_id uuid references public.item_types(id) on delete set null,
  item_title text,
  item_barcode text,
  photo_path text not null,
  storage_bucket text not null default 'photos',
  deleted_by uuid references auth.users(id) on delete set null default auth.uid(),
  deleted_by_email text,
  deleted_at timestamptz not null default now(),
  reason text,
  item_snapshot jsonb,
  remaining_photos text[] not null default '{}'::text[],
  location_lat double precision,
  location_lng double precision,
  user_agent text,
  status text not null default 'requested',
  storage_removed boolean not null default false,
  storage_error text,
  constraint photo_deletion_log_status_check
    check (status in ('requested', 'completed', 'metadata_removed_storage_failed', 'failed'))
);

alter table public.photo_deletion_log enable row level security;

drop policy if exists "photo_deletion_log_admin_select" on public.photo_deletion_log;
drop policy if exists "photo_deletion_log_admin_insert" on public.photo_deletion_log;
drop policy if exists "photo_deletion_log_admin_update" on public.photo_deletion_log;

create policy "photo_deletion_log_admin_select"
on public.photo_deletion_log
for select
to authenticated
using (public.is_admin());

create policy "photo_deletion_log_admin_insert"
on public.photo_deletion_log
for insert
to authenticated
with check (public.is_admin() and deleted_by = auth.uid());

create policy "photo_deletion_log_admin_update"
on public.photo_deletion_log
for update
to authenticated
using (public.is_admin() and deleted_by = auth.uid())
with check (public.is_admin() and deleted_by = auth.uid());

grant select, insert, update on table public.photo_deletion_log to authenticated;
grant select, insert, update, delete on table public.photo_deletion_log to service_role;

create index if not exists photo_deletion_log_item_idx
  on public.photo_deletion_log(item_id, deleted_at desc);

create index if not exists photo_deletion_log_deleted_by_idx
  on public.photo_deletion_log(deleted_by, deleted_at desc);
