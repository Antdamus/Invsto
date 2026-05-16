-- When an item is deleted as a bad intake, remove its active stock placements too.
-- The placement rows are snapshotted on the item so admin restore/revert can put them back.

alter table public.item_types
  add column if not exists deletion_stock_snapshot jsonb not null default '[]'::jsonb;
create or replace function public.restore_item_stock_snapshot(
  _item_id uuid,
  _snapshot jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_restored integer := 0;
begin
  if _item_id is null or jsonb_typeof(coalesce(_snapshot, '[]'::jsonb)) <> 'array' then
    return 0;
  end if;

  insert into public.item_stock_locations (
    id,
    item_id,
    quantity,
    last_updated,
    added_by,
    confirmation_email,
    confirmation_method,
    confirmed_at,
    location_id,
    locked_by,
    locked_at,
    batch_id
  )
  select
    coalesce(nullif(row_data ->> 'id', '')::uuid, gen_random_uuid()),
    _item_id,
    coalesce(nullif(row_data ->> 'quantity', '')::integer, 0),
    coalesce(nullif(row_data ->> 'last_updated', '')::timestamptz, now()),
    nullif(row_data ->> 'added_by', '')::uuid,
    nullif(row_data ->> 'confirmation_email', ''),
    nullif(row_data ->> 'confirmation_method', ''),
    coalesce(nullif(row_data ->> 'confirmed_at', '')::timestamptz, now()),
    nullif(row_data ->> 'location_id', '')::uuid,
    nullif(row_data ->> 'locked_by', '')::uuid,
    nullif(row_data ->> 'locked_at', '')::timestamptz,
    nullif(row_data ->> 'batch_id', '')::uuid
  from jsonb_array_elements(coalesce(_snapshot, '[]'::jsonb)) as source(row_data)
  where nullif(row_data ->> 'location_id', '') is not null
  on conflict (id) do update
    set quantity = excluded.quantity,
        last_updated = excluded.last_updated,
        added_by = excluded.added_by,
        confirmation_email = excluded.confirmation_email,
        confirmation_method = excluded.confirmation_method,
        confirmed_at = excluded.confirmed_at,
        location_id = excluded.location_id,
        locked_by = excluded.locked_by,
        locked_at = excluded.locked_at,
        batch_id = excluded.batch_id;

  get diagnostics v_restored = row_count;
  return coalesce(v_restored, 0);
end;
$$;
revoke all on function public.restore_item_stock_snapshot(uuid, jsonb) from public;
do $$
begin
  perform set_config('app.inventory_change_reason', 'Migration cleanup: remove placements for deleted items', true);
  perform set_config('app.inventory_change_verified_method', 'migration_cleanup', true);
  perform set_config('app.inventory_change_verified_at', now()::text, true);

  update public.item_types it
  set deletion_stock_snapshot = coalesce((
    select jsonb_agg(to_jsonb(isl) order by isl.confirmed_at, isl.id)
    from public.item_stock_locations isl
    where isl.item_id = it.id
  ), '[]'::jsonb)
  where it.deleted_at is not null
    and coalesce(jsonb_array_length(it.deletion_stock_snapshot), 0) = 0
    and exists (
      select 1
      from public.item_stock_locations isl
      where isl.item_id = it.id
    );

  delete from public.item_stock_locations isl
  using public.item_types it
  where it.id = isl.item_id
    and it.deleted_at is not null;
end $$;
create or replace function public.delete_inventory_items(
  _item_ids uuid[],
  _reason text,
  _signed_by_email text default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := nullif(btrim(coalesce(_reason, '')), '');
  v_count integer := 0;
  v_is_admin boolean := public.is_admin();
  v_verified_at timestamptz := now();
  v_jwt_email text;
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to delete inventory items' using errcode = '42501';
  end if;

  if _item_ids is null or array_length(_item_ids, 1) is null then
    raise exception 'At least one item is required' using errcode = '22023';
  end if;

  if v_reason is null or length(v_reason) < 3 then
    raise exception 'A brief reason for deleting the item is required' using errcode = '22023';
  end if;

  begin
    v_jwt_email := (current_setting('request.jwt.claims', true)::jsonb ->> 'email');
  exception when others then
    v_jwt_email := null;
  end;

  if exists (
    select 1
    from public.item_types it
    where it.id = any(_item_ids)
      and it.deleted_at is null
      and not v_is_admin
      and (
        not (
          it.added_by = auth.uid()
          or (
            v_jwt_email is not null
            and lower(coalesce(it.added_by_email, '')) = lower(v_jwt_email)
          )
        )
        or not public.is_same_new_york_day(it.created_at)
      )
  ) then
    raise exception 'Workers can only delete items they created today' using errcode = '42501';
  end if;

  perform set_config('app.inventory_change_reason', v_reason, true);
  perform set_config('app.inventory_change_signed_by_email', coalesce(_signed_by_email, ''), true);
  perform set_config('app.inventory_change_verified_method', 'password', true);
  perform set_config('app.inventory_change_verified_at', v_verified_at::text, true);

  update public.item_types it
  set deleted_at = v_verified_at,
      deleted_by = auth.uid(),
      deleted_by_email = nullif(btrim(coalesce(_signed_by_email, '')), ''),
      deletion_reason = v_reason,
      deletion_status = 'deleted',
      restored_at = null,
      restored_by = null,
      restored_by_email = null,
      restore_reason = null,
      deletion_stock_snapshot = coalesce((
        select jsonb_agg(to_jsonb(isl) order by isl.confirmed_at, isl.id)
        from public.item_stock_locations isl
        where isl.item_id = it.id
      ), '[]'::jsonb)
  where it.id = any(_item_ids)
    and it.deleted_at is null;

  get diagnostics v_count = row_count;

  if v_count <> array_length(_item_ids, 1) then
    raise exception 'Some selected items could not be deleted or were already deleted' using errcode = 'P0002';
  end if;

  delete from public.item_stock_locations isl
  where isl.item_id = any(_item_ids);

  return v_count;
end;
$$;
revoke all on function public.delete_inventory_items(uuid[], text, text) from public;
grant execute on function public.delete_inventory_items(uuid[], text, text) to authenticated;
create or replace function public.restore_inventory_items(
  _item_ids uuid[],
  _reason text,
  _signed_by_email text default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := nullif(btrim(coalesce(_reason, '')), '');
  v_count integer := 0;
  v_verified_at timestamptz := now();
  v_item record;
begin
  if not public.is_admin() then
    raise exception 'Only admins can restore deleted inventory items' using errcode = '42501';
  end if;

  if _item_ids is null or array_length(_item_ids, 1) is null then
    raise exception 'At least one item is required' using errcode = '22023';
  end if;

  if v_reason is null or length(v_reason) < 3 then
    raise exception 'A brief reason for restoring the item is required' using errcode = '22023';
  end if;

  perform set_config('app.inventory_change_reason', v_reason, true);
  perform set_config('app.inventory_change_signed_by_email', coalesce(_signed_by_email, ''), true);
  perform set_config('app.inventory_change_verified_method', 'password', true);
  perform set_config('app.inventory_change_verified_at', v_verified_at::text, true);

  for v_item in
    select id, deletion_stock_snapshot
    from public.item_types
    where id = any(_item_ids)
      and deleted_at is not null
    for update
  loop
    perform public.restore_item_stock_snapshot(v_item.id, v_item.deletion_stock_snapshot);
  end loop;

  update public.item_types
  set deleted_at = null,
      deleted_by = null,
      deleted_by_email = null,
      deletion_reason = null,
      deletion_status = 'active',
      restored_at = v_verified_at,
      restored_by = auth.uid(),
      restored_by_email = nullif(btrim(coalesce(_signed_by_email, '')), ''),
      restore_reason = v_reason,
      deletion_stock_snapshot = '[]'::jsonb
  where id = any(_item_ids)
    and deleted_at is not null;

  get diagnostics v_count = row_count;

  if v_count <> array_length(_item_ids, 1) then
    raise exception 'Some selected items could not be restored or were not deleted' using errcode = 'P0002';
  end if;

  return v_count;
end;
$$;
revoke all on function public.restore_inventory_items(uuid[], text, text) from public;
grant execute on function public.restore_inventory_items(uuid[], text, text) to authenticated;
create or replace function public.revert_inventory_deletion(
  _change_id uuid,
  _direction text default 'revert',
  _admin_email text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_log public.inventory_change_log%rowtype;
  v_direction text := lower(coalesce(nullif(btrim(_direction), ''), 'revert'));
  v_before jsonb;
  v_after jsonb;
  v_diff jsonb;
  v_reversion_id uuid;
  v_reason text;
  v_deleted_at timestamptz;
  v_deleted_by uuid;
  v_deleted_by_email text;
  v_deletion_reason text;
  v_stock_snapshot jsonb := '[]'::jsonb;
  v_keys text[] := array[
    'deleted_at',
    'deleted_by',
    'deleted_by_email',
    'deletion_reason',
    'deletion_status',
    'restored_at',
    'restored_by',
    'restored_by_email',
    'restore_reason',
    'deletion_stock_snapshot'
  ];
begin
  if not public.is_admin() then
    raise exception 'Only admins can revert inventory deletions' using errcode = '42501';
  end if;

  if _change_id is null then
    raise exception 'Change id is required' using errcode = '22023';
  end if;

  if v_direction not in ('revert', 'reapply') then
    raise exception 'Direction must be revert or reapply' using errcode = '22023';
  end if;

  select *
    into v_log
  from public.inventory_change_log
  where id = _change_id
  for update;

  if not found then
    raise exception 'Inventory deletion change not found' using errcode = 'P0002';
  end if;

  if v_log.table_name <> 'item_types'
     or v_log.action <> 'update'
     or not coalesce(v_log.changed_fields, '{}'::jsonb) ? 'deleted_at' then
    raise exception 'This change is not an item deletion change' using errcode = '22023';
  end if;

  select to_jsonb(it)
    into v_before
  from public.item_types it
  where it.id = v_log.record_id
  for update;

  if v_before is null then
    raise exception 'Item no longer exists for this deletion change' using errcode = 'P0002';
  end if;

  v_reason := case
    when v_direction = 'revert' then 'Admin reverted item deletion'
    else 'Admin reapplied item deletion'
  end;

  perform set_config('app.inventory_change_reason', v_reason, true);
  perform set_config('app.inventory_change_signed_by_email', coalesce(_admin_email, ''), true);
  perform set_config('app.inventory_change_verified_method', 'admin_revert', true);
  perform set_config('app.inventory_change_verified_at', now()::text, true);

  if v_direction = 'revert' then
    perform public.restore_item_stock_snapshot(
      v_log.record_id,
      coalesce(v_before -> 'deletion_stock_snapshot', v_log.new_data -> 'deletion_stock_snapshot', '[]'::jsonb)
    );

    update public.item_types as it
    set deleted_at = null,
        deleted_by = null,
        deleted_by_email = null,
        deletion_reason = null,
        deletion_status = 'active',
        restored_at = now(),
        restored_by = auth.uid(),
        restored_by_email = nullif(btrim(coalesce(_admin_email, '')), ''),
        restore_reason = v_reason,
        deletion_stock_snapshot = '[]'::jsonb
    where it.id = v_log.record_id
    returning to_jsonb(it) into v_after;
  else
    v_stock_snapshot := coalesce((
      select jsonb_agg(to_jsonb(isl) order by isl.confirmed_at, isl.id)
      from public.item_stock_locations isl
      where isl.item_id = v_log.record_id
    ), v_log.new_data -> 'deletion_stock_snapshot', '[]'::jsonb);
    v_deleted_at := coalesce(nullif(v_log.new_data ->> 'deleted_at', '')::timestamptz, now());
    v_deleted_by := coalesce(nullif(v_log.new_data ->> 'deleted_by', '')::uuid, auth.uid());
    v_deleted_by_email := coalesce(nullif(v_log.new_data ->> 'deleted_by_email', ''), nullif(btrim(coalesce(_admin_email, '')), ''));
    v_deletion_reason := coalesce(nullif(v_log.new_data ->> 'deletion_reason', ''), v_reason);

    update public.item_types as it
    set deleted_at = v_deleted_at,
        deleted_by = v_deleted_by,
        deleted_by_email = v_deleted_by_email,
        deletion_reason = v_deletion_reason,
        deletion_status = 'deleted',
        restored_at = null,
        restored_by = null,
        restored_by_email = null,
        restore_reason = null,
        deletion_stock_snapshot = v_stock_snapshot
    where it.id = v_log.record_id
    returning to_jsonb(it) into v_after;

    delete from public.item_stock_locations isl
    where isl.item_id = v_log.record_id;
  end if;

  v_diff := public.build_change_reversion_diff(v_before, v_after, v_keys);
  if v_diff = '{}'::jsonb then
    raise exception 'This item is already in the requested deletion state' using errcode = '22023';
  end if;

  insert into public.change_reversion_log (
    source_type,
    source_id,
    direction,
    table_name,
    record_id,
    item_id,
    item_title,
    item_barcode,
    location_id,
    location_name,
    store_id,
    store_name,
    changed_fields,
    before_data,
    after_data,
    performed_by,
    performed_by_email,
    reason
  )
  values (
    'inventory_change_log',
    v_log.id,
    v_direction,
    v_log.table_name,
    v_log.record_id,
    v_log.item_id,
    v_log.item_title,
    v_log.item_barcode,
    v_log.location_id,
    v_log.location_name,
    v_log.store_id,
    v_log.store_name,
    v_diff,
    v_before,
    v_after,
    auth.uid(),
    _admin_email,
    v_reason
  )
  returning id into v_reversion_id;

  update public.inventory_change_log
  set revert_direction = v_direction,
      reverted_at = now(),
      reverted_by = auth.uid(),
      reverted_by_email = _admin_email,
      revert_count = coalesce(revert_count, 0) + 1
  where id = v_log.id;

  return v_reversion_id;
end;
$$;
revoke all on function public.revert_inventory_deletion(uuid, text, text) from public;
grant execute on function public.revert_inventory_deletion(uuid, text, text) to authenticated;
