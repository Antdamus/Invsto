-- Reversible admin change history.
-- Lets admins revert/reapply audited item/location changes while preserving a separate trail of the reversal.

alter table public.inventory_change_log
  add column if not exists revert_direction text,
  add column if not exists reverted_at timestamptz,
  add column if not exists reverted_by uuid references auth.users(id) on delete set null,
  add column if not exists reverted_by_email text,
  add column if not exists revert_count integer not null default 0;
alter table public.photo_deletion_log
  add column if not exists revert_direction text,
  add column if not exists reverted_at timestamptz,
  add column if not exists reverted_by uuid references auth.users(id) on delete set null,
  add column if not exists reverted_by_email text,
  add column if not exists revert_count integer not null default 0;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'inventory_change_log_revert_direction_check'
      and conrelid = 'public.inventory_change_log'::regclass
  ) then
    alter table public.inventory_change_log
      add constraint inventory_change_log_revert_direction_check
      check (revert_direction is null or revert_direction in ('revert', 'reapply'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'photo_deletion_log_revert_direction_check'
      and conrelid = 'public.photo_deletion_log'::regclass
  ) then
    alter table public.photo_deletion_log
      add constraint photo_deletion_log_revert_direction_check
      check (revert_direction is null or revert_direction in ('revert', 'reapply'));
  end if;
end $$;
create table if not exists public.change_reversion_log (
  id uuid primary key default gen_random_uuid(),
  source_type text not null check (source_type in ('inventory_change_log', 'photo_deletion_log')),
  source_id uuid not null,
  direction text not null check (direction in ('revert', 'reapply')),
  table_name text,
  record_id uuid,
  item_id uuid references public.item_types(id) on delete set null,
  item_title text,
  item_barcode text,
  location_id uuid references public.locations(id) on delete set null,
  location_name text,
  store_id uuid references public.store_locations(id) on delete set null,
  store_name text,
  changed_fields jsonb not null default '{}'::jsonb,
  before_data jsonb,
  after_data jsonb,
  performed_by uuid references auth.users(id) on delete set null default auth.uid(),
  performed_by_email text,
  performed_at timestamptz not null default now(),
  reason text
);
create index if not exists change_reversion_log_performed_at_idx
  on public.change_reversion_log(performed_at desc);
create index if not exists change_reversion_log_source_idx
  on public.change_reversion_log(source_type, source_id, performed_at desc);
create index if not exists change_reversion_log_item_idx
  on public.change_reversion_log(item_id, performed_at desc);
alter table public.change_reversion_log enable row level security;
drop policy if exists "change_reversion_log_admin_select" on public.change_reversion_log;
create policy "change_reversion_log_admin_select"
on public.change_reversion_log
for select
to authenticated
using (public.is_admin());
grant select on table public.change_reversion_log to authenticated;
grant select, insert, update, delete on table public.change_reversion_log to service_role;
create or replace function public.build_change_reversion_diff(
  _before jsonb,
  _after jsonb,
  _keys text[]
)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_result jsonb := '{}'::jsonb;
  v_key text;
begin
  foreach v_key in array coalesce(_keys, '{}'::text[]) loop
    if (_before -> v_key) is distinct from (_after -> v_key) then
      v_result := jsonb_set(
        v_result,
        array[v_key],
        jsonb_build_object('from', _before -> v_key, 'to', _after -> v_key),
        true
      );
    end if;
  end loop;

  return v_result;
end;
$$;
create or replace function public.revert_inventory_change(
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
  v_target jsonb;
  v_patch jsonb := '{}'::jsonb;
  v_keys text[] := '{}'::text[];
  v_before jsonb := '{}'::jsonb;
  v_after jsonb := '{}'::jsonb;
  v_diff jsonb := '{}'::jsonb;
  v_reason text;
  v_reversion_id uuid;
  v_item_before public.item_types;
  v_item_target public.item_types;
  v_stock_before public.item_stock_locations;
  v_stock_target public.item_stock_locations;
  v_location_before public.locations;
  v_location_target public.locations;
begin
  if not public.is_admin() then
    raise exception 'Only admins can revert inventory changes' using errcode = '42501';
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
    raise exception 'Inventory change not found' using errcode = 'P0002';
  end if;

  if v_log.action <> 'update' then
    raise exception 'Only update changes can be reverted from this console' using errcode = '22023';
  end if;

  v_target := case when v_direction = 'revert' then v_log.old_data else v_log.new_data end;
  if v_target is null or v_target = '{}'::jsonb then
    raise exception 'This change does not have a complete target snapshot' using errcode = '22023';
  end if;

  select
    coalesce(array_agg(f.key order by f.key), '{}'::text[]),
    coalesce(jsonb_object_agg(f.key, v_target -> f.key), '{}'::jsonb)
    into v_keys, v_patch
  from jsonb_object_keys(coalesce(v_log.changed_fields, '{}'::jsonb)) as f(key)
  where v_target ? f.key
    and f.key not in ('id', 'created_at', 'updated_at', 'last_updated', 'confirmed_at');

  if array_length(v_keys, 1) is null then
    raise exception 'No reversible fields were found on this change' using errcode = '22023';
  end if;

  v_reason := case
    when v_direction = 'revert' then 'Admin reverted audited change'
    else 'Admin reapplied audited change'
  end;

  perform set_config('app.inventory_change_reason', v_reason, true);
  perform set_config('app.inventory_change_signed_by_email', coalesce(_admin_email, ''), true);
  perform set_config('app.inventory_change_verified_method', 'admin_revert', true);
  perform set_config('app.inventory_change_verified_at', now()::text, true);

  if v_log.table_name = 'item_types' then
    select *
      into v_item_before
    from public.item_types
    where id = v_log.record_id
    for update;

    if not found then
      raise exception 'Item no longer exists for this change' using errcode = 'P0002';
    end if;

    select *
      into v_item_target
    from jsonb_populate_record(v_item_before, v_patch);

    v_before := to_jsonb(v_item_before);

    update public.item_types as it
    set title = v_item_target.title,
        description = v_item_target.description,
        weight = v_item_target.weight,
        cost = v_item_target.cost,
        sale_price = v_item_target.sale_price,
        distributor_name = v_item_target.distributor_name,
        distributor_phone = v_item_target.distributor_phone,
        distributor_notes = v_item_target.distributor_notes,
        barcode = v_item_target.barcode,
        qr_code = v_item_target.qr_code,
        photo_url = v_item_target.photo_url,
        dymo_label_url = v_item_target.dymo_label_url,
        photos = coalesce(v_item_target.photos, '{}'::text[]),
        qr_type = v_item_target.qr_type,
        categories = v_item_target.categories,
        stock = v_item_target.stock,
        stock_batch_size_update = v_item_target.stock_batch_size_update,
        price_per_weight = v_item_target.price_per_weight,
        metal = v_item_target.metal,
        purity_basis_points = v_item_target.purity_basis_points,
        metal_weight_g = v_item_target.metal_weight_g,
        stone_type = v_item_target.stone_type,
        item_length = v_item_target.item_length
    where it.id = v_item_before.id
    returning to_jsonb(it) into v_after;
  elsif v_log.table_name = 'item_stock_locations' then
    select *
      into v_stock_before
    from public.item_stock_locations
    where id = v_log.record_id
    for update;

    if not found then
      raise exception 'Stock placement no longer exists for this change' using errcode = 'P0002';
    end if;

    select *
      into v_stock_target
    from jsonb_populate_record(v_stock_before, v_patch);

    v_before := to_jsonb(v_stock_before);

    update public.item_stock_locations as isl
    set item_id = v_stock_target.item_id,
        quantity = v_stock_target.quantity,
        location_id = v_stock_target.location_id,
        locked_by = v_stock_target.locked_by,
        locked_at = v_stock_target.locked_at,
        batch_id = v_stock_target.batch_id,
        confirmation_email = coalesce(_admin_email, v_stock_target.confirmation_email),
        confirmation_method = 'admin_revert',
        confirmed_at = now(),
        last_updated = now()
    where isl.id = v_stock_before.id
    returning to_jsonb(isl) into v_after;
  elsif v_log.table_name = 'locations' then
    select *
      into v_location_before
    from public.locations
    where id = v_log.record_id
    for update;

    if not found then
      raise exception 'Location no longer exists for this change' using errcode = 'P0002';
    end if;

    select *
      into v_location_target
    from jsonb_populate_record(v_location_before, v_patch);

    v_before := to_jsonb(v_location_before);

    update public.locations as loc
    set location_name = v_location_target.location_name,
        location_code = v_location_target.location_code,
        dymo_label_url = v_location_target.dymo_label_url,
        photo_url = v_location_target.photo_url,
        type = v_location_target.type,
        max_capacity = v_location_target.max_capacity,
        active = v_location_target.active,
        notes = v_location_target.notes,
        store_id = v_location_target.store_id,
        is_tray = v_location_target.is_tray,
        tray_status = v_location_target.tray_status,
        tray_weight_tolerance_grams = v_location_target.tray_weight_tolerance_grams,
        tray_current_store_id = v_location_target.tray_current_store_id,
        tray_last_checkout_weight = v_location_target.tray_last_checkout_weight,
        tray_last_checkin_weight = v_location_target.tray_last_checkin_weight,
        tray_last_weight_delta = v_location_target.tray_last_weight_delta,
        tray_checked_out_at = v_location_target.tray_checked_out_at,
        tray_checked_out_by = v_location_target.tray_checked_out_by,
        tray_checked_in_at = v_location_target.tray_checked_in_at,
        tray_checked_in_by = v_location_target.tray_checked_in_by,
        updated_at = now()
    where loc.id = v_location_before.id
    returning to_jsonb(loc) into v_after;
  else
    raise exception 'Changes on % are not reversible from this console', v_log.table_name using errcode = '22023';
  end if;

  v_diff := public.build_change_reversion_diff(v_before, v_after, v_keys);
  if v_diff = '{}'::jsonb then
    raise exception 'This record is already in the requested state' using errcode = '22023';
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
create or replace function public.revert_photo_deletion_change(
  _log_id uuid,
  _direction text default 'revert',
  _admin_email text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_log public.photo_deletion_log%rowtype;
  v_direction text := lower(coalesce(nullif(btrim(_direction), ''), 'revert'));
  v_before jsonb;
  v_after jsonb;
  v_diff jsonb;
  v_reason text;
  v_reversion_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Only admins can revert photo deletion changes' using errcode = '42501';
  end if;

  if _log_id is null then
    raise exception 'Photo deletion log id is required' using errcode = '22023';
  end if;

  if v_direction not in ('revert', 'reapply') then
    raise exception 'Direction must be revert or reapply' using errcode = '22023';
  end if;

  select *
    into v_log
  from public.photo_deletion_log
  where id = _log_id
  for update;

  if not found then
    raise exception 'Photo deletion log not found' using errcode = 'P0002';
  end if;

  if v_log.item_id is null or nullif(btrim(coalesce(v_log.photo_path, '')), '') is null then
    raise exception 'This photo deletion log is missing item or photo data' using errcode = '22023';
  end if;

  select to_jsonb(it)
    into v_before
  from public.item_types it
  where it.id = v_log.item_id
  for update;

  if not found then
    raise exception 'Item not found for photo reversal' using errcode = 'P0002';
  end if;

  v_reason := case
    when v_direction = 'revert' then 'Admin restored deleted photo'
    else 'Admin reapplied photo deletion'
  end;

  perform set_config('app.inventory_change_reason', v_reason, true);
  perform set_config('app.inventory_change_signed_by_email', coalesce(_admin_email, ''), true);
  perform set_config('app.inventory_change_verified_method', 'admin_revert', true);
  perform set_config('app.inventory_change_verified_at', now()::text, true);

  if v_direction = 'revert' then
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
    returning to_jsonb(it) into v_after;
  else
    update public.item_types it
    set photos = (
      select coalesce(array_agg(photo_path order by ord), '{}'::text[])
      from unnest(coalesce(it.photos, '{}'::text[])) with ordinality as source(photo_path, ord)
      where photo_path <> v_log.photo_path
    )
    where it.id = v_log.item_id
    returning to_jsonb(it) into v_after;
  end if;

  v_diff := public.build_change_reversion_diff(v_before, v_after, array['photos']);
  if v_diff = '{}'::jsonb then
    raise exception 'This photo is already in the requested state' using errcode = '22023';
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
    changed_fields,
    before_data,
    after_data,
    performed_by,
    performed_by_email,
    reason
  )
  values (
    'photo_deletion_log',
    v_log.id,
    v_direction,
    'item_types',
    v_log.item_id,
    v_log.item_id,
    v_log.item_title,
    v_log.item_barcode,
    v_diff,
    v_before,
    v_after,
    auth.uid(),
    _admin_email,
    v_reason
  )
  returning id into v_reversion_id;

  update public.photo_deletion_log
  set status = case when v_direction = 'revert' then 'restored' else 'completed' end,
      restored_at = case when v_direction = 'revert' then now() else null end,
      restored_by = case when v_direction = 'revert' then auth.uid() else null end,
      restored_by_email = case when v_direction = 'revert' then _admin_email else null end,
      restore_error = null,
      revert_direction = v_direction,
      reverted_at = now(),
      reverted_by = auth.uid(),
      reverted_by_email = _admin_email,
      revert_count = coalesce(revert_count, 0) + 1
  where id = v_log.id;

  return v_reversion_id;
end;
$$;
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
  v_log public.photo_deletion_log%rowtype;
  v_next_photos text[];
begin
  perform public.revert_photo_deletion_change(_log_id, 'revert', _restored_by_email);

  select *
    into v_log
  from public.photo_deletion_log
  where id = _log_id;

  select coalesce(it.photos, '{}'::text[])
    into v_next_photos
  from public.item_types it
  where it.id = v_log.item_id;

  return coalesce(v_next_photos, '{}'::text[]);
end;
$$;
revoke all on function public.build_change_reversion_diff(jsonb, jsonb, text[]) from public;
revoke all on function public.revert_inventory_change(uuid, text, text) from public;
revoke all on function public.revert_photo_deletion_change(uuid, text, text) from public;
revoke all on function public.restore_quarantined_item_photo(uuid, text) from public;
grant execute on function public.revert_inventory_change(uuid, text, text) to authenticated;
grant execute on function public.revert_photo_deletion_change(uuid, text, text) to authenticated;
grant execute on function public.restore_quarantined_item_photo(uuid, text) to authenticated;
