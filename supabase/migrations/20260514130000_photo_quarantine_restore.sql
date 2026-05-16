-- Recoverable photo deletion support.
-- Deleted item photos are copied to a private quarantine bucket before they are removed from the visible item.

insert into storage.buckets (id, name, public)
values ('photo-quarantine', 'photo-quarantine', false)
on conflict (id) do nothing;
alter table public.photo_deletion_log
  add column if not exists quarantine_bucket text,
  add column if not exists quarantine_path text,
  add column if not exists quarantined_at timestamptz,
  add column if not exists restored_at timestamptz,
  add column if not exists restored_by uuid references auth.users(id) on delete set null,
  add column if not exists restored_by_email text,
  add column if not exists restore_error text;
do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'photo_deletion_log_status_check'
      and conrelid = 'public.photo_deletion_log'::regclass
  ) then
    alter table public.photo_deletion_log
      drop constraint photo_deletion_log_status_check;
  end if;

  alter table public.photo_deletion_log
    add constraint photo_deletion_log_status_check
    check (status in (
      'requested',
      'quarantined',
      'completed',
      'restored',
      'metadata_removed_storage_failed',
      'restore_failed',
      'failed'
    ));
end $$;
create index if not exists photo_deletion_log_quarantine_idx
  on public.photo_deletion_log(status, deleted_at desc)
  where quarantine_path is not null;
drop policy if exists "Inventory staff upload quarantined photos" on storage.objects;
create policy "Inventory staff upload quarantined photos"
on storage.objects
for insert
to authenticated
with check (bucket_id = 'photo-quarantine' and public.can_manage_inventory());
drop policy if exists "Admins read quarantined photos" on storage.objects;
create policy "Admins read quarantined photos"
on storage.objects
for select
to authenticated
using (bucket_id = 'photo-quarantine' and public.is_admin());
drop policy if exists "Admins update quarantined photos" on storage.objects;
create policy "Admins update quarantined photos"
on storage.objects
for update
to authenticated
using (bucket_id = 'photo-quarantine' and public.is_admin())
with check (bucket_id = 'photo-quarantine' and public.is_admin());
create or replace function public.restore_quarantined_item_photo(
  _log_id uuid,
  _restored_by_email text default null
)
returns text[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_log public.photo_deletion_log;
  v_next_photos text[];
  v_can_mark_failure boolean := false;
begin
  if not public.is_admin() then
    raise exception 'Only admins can restore deleted item photos' using errcode = '42501';
  end if;

  if _log_id is null then
    raise exception 'Deletion log id is required' using errcode = '22023';
  end if;

  select *
    into v_log
  from public.photo_deletion_log
  where id = _log_id
  for update;

  if not found then
    raise exception 'Photo deletion log not found' using errcode = 'P0002';
  end if;
  v_can_mark_failure := true;

  if v_log.item_id is null or nullif(btrim(coalesce(v_log.photo_path, '')), '') is null then
    raise exception 'This deletion log cannot be restored because it is missing item or photo data' using errcode = '22023';
  end if;

  update public.item_types it
  set photos = (
    select coalesce(array_agg(photo_path order by first_seen), '{}'::text[])
    from (
      select photo_path, min(ord) as first_seen
      from unnest(coalesce(it.photos, '{}'::text[]) || array[v_log.photo_path])
        with ordinality as source(photo_path, ord)
      where nullif(btrim(photo_path), '') is not null
      group by photo_path
    ) unique_photos
  )
  where it.id = v_log.item_id
  returning it.photos into v_next_photos;

  if not found then
    raise exception 'Item not found for restore' using errcode = 'P0002';
  end if;

  update public.photo_deletion_log
  set status = 'restored',
      restored_at = now(),
      restored_by = auth.uid(),
      restored_by_email = coalesce(_restored_by_email, restored_by_email),
      restore_error = null
  where id = _log_id;

  return coalesce(v_next_photos, '{}'::text[]);
exception when others then
  if v_can_mark_failure then
    update public.photo_deletion_log
    set status = 'restore_failed',
        restore_error = sqlerrm
    where id = _log_id;
  end if;
  raise;
end;
$$;
revoke all on function public.restore_quarantined_item_photo(uuid, text) from public;
grant execute on function public.restore_quarantined_item_photo(uuid, text) to authenticated;
