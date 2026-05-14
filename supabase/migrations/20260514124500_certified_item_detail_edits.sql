-- Certified item detail edits for the stock edit modal.
-- Workers may correct descriptive fields only; admins keep the fuller edit surface.

alter table public.item_types
  add column if not exists stone_type text,
  add column if not exists item_length text;

alter table public.inventory_change_log
  add column if not exists reason text,
  add column if not exists signed_by uuid references auth.users(id) on delete set null,
  add column if not exists signed_by_email text,
  add column if not exists verified_method text,
  add column if not exists verified_at timestamptz;

create or replace function public.log_inventory_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else '{}'::jsonb end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else '{}'::jsonb end;
  v_changed_fields jsonb := '{}'::jsonb;
  v_key text;
  v_action text := lower(tg_op);
  v_record_id uuid;
  v_item_id uuid;
  v_item_title text;
  v_item_barcode text;
  v_location_id uuid;
  v_location_name text;
  v_store_id uuid;
  v_store_name text;
  v_worker_id uuid := auth.uid();
  v_worker_email text;
  v_jwt_email text;
  v_summary text;
  v_reason text := nullif(current_setting('app.inventory_change_reason', true), '');
  v_signed_by_email text := nullif(current_setting('app.inventory_change_signed_by_email', true), '');
  v_verified_method text := nullif(current_setting('app.inventory_change_verified_method', true), '');
  v_verified_at timestamptz;
begin
  begin
    v_verified_at := nullif(current_setting('app.inventory_change_verified_at', true), '')::timestamptz;
  exception when others then
    v_verified_at := null;
  end;

  if tg_op = 'UPDATE' then
    for v_key in
      select key
      from jsonb_object_keys((v_old - array['updated_at','last_updated','confirmed_at']::text[]) || (v_new - array['updated_at','last_updated','confirmed_at']::text[])) as key
    loop
      if (v_old -> v_key) is distinct from (v_new -> v_key) then
        v_changed_fields := jsonb_set(
          v_changed_fields,
          array[v_key],
          jsonb_build_object('from', v_old -> v_key, 'to', v_new -> v_key),
          true
        );
      end if;
    end loop;

    if v_changed_fields = '{}'::jsonb then
      return new;
    end if;
  elsif tg_op = 'INSERT' then
    v_changed_fields := jsonb_build_object('record', jsonb_build_object('from', null, 'to', v_new));
  elsif tg_op = 'DELETE' then
    v_changed_fields := jsonb_build_object('record', jsonb_build_object('from', v_old, 'to', null));
  end if;

  v_record_id := coalesce((v_new ->> 'id')::uuid, (v_old ->> 'id')::uuid);

  if tg_table_name = 'item_types' then
    v_item_id := v_record_id;
    v_location_id := null;
  elsif tg_table_name = 'item_stock_locations' then
    v_item_id := coalesce((v_new ->> 'item_id')::uuid, (v_old ->> 'item_id')::uuid);
    v_location_id := coalesce((v_new ->> 'location_id')::uuid, (v_old ->> 'location_id')::uuid);
  elsif tg_table_name = 'locations' then
    v_location_id := v_record_id;
  end if;

  if v_worker_id is null then
    v_worker_id := nullif(coalesce(v_new ->> 'added_by', v_old ->> 'added_by'), '')::uuid;
  end if;

  if v_item_id is not null then
    select it.title, it.barcode
      into v_item_title, v_item_barcode
    from public.item_types it
    where it.id = v_item_id;
  end if;

  if tg_table_name = 'item_types' then
    v_item_title := coalesce(v_item_title, v_new ->> 'title', v_old ->> 'title');
    v_item_barcode := coalesce(v_item_barcode, v_new ->> 'barcode', v_old ->> 'barcode');
  end if;

  if v_location_id is not null then
    select l.location_name, l.store_id
      into v_location_name, v_store_id
    from public.locations l
    where l.id = v_location_id;
  end if;

  if tg_table_name = 'locations' then
    v_location_name := coalesce(v_location_name, v_new ->> 'location_name', v_old ->> 'location_name');
    v_store_id := coalesce(v_store_id, nullif(coalesce(v_new ->> 'store_id', v_old ->> 'store_id'), '')::uuid);
  end if;

  if v_store_id is not null then
    select s.name
      into v_store_name
    from public.store_locations s
    where s.id = v_store_id;
  end if;

  select e.email
    into v_worker_email
  from public.employees e
  where e.user_id = v_worker_id
  limit 1;

  begin
    v_jwt_email := (current_setting('request.jwt.claims', true)::jsonb ->> 'email');
  exception when others then
    v_jwt_email := null;
  end;

  v_worker_email := coalesce(
    v_worker_email,
    v_signed_by_email,
    v_new ->> 'added_by_email',
    v_old ->> 'added_by_email',
    v_new ->> 'confirmation_email',
    v_old ->> 'confirmation_email',
    v_jwt_email
  );

  v_summary := case
    when tg_table_name = 'item_types' and v_action = 'insert' then 'Created item type'
    when tg_table_name = 'item_types' and v_action = 'update' then 'Updated item type'
    when tg_table_name = 'item_types' and v_action = 'delete' then 'Deleted item type'
    when tg_table_name = 'item_stock_locations' and v_action = 'insert' then 'Added stock placement'
    when tg_table_name = 'item_stock_locations' and v_action = 'update' then 'Updated stock placement'
    when tg_table_name = 'item_stock_locations' and v_action = 'delete' then 'Removed stock placement'
    when tg_table_name = 'locations' and v_action = 'insert' then 'Created location or tray'
    when tg_table_name = 'locations' and v_action = 'update' then 'Updated location or tray'
    when tg_table_name = 'locations' and v_action = 'delete' then 'Deleted location or tray'
    else initcap(v_action) || ' ' || tg_table_name
  end;

  insert into public.inventory_change_log (
    table_name,
    record_id,
    action,
    item_id,
    item_title,
    item_barcode,
    location_id,
    location_name,
    store_id,
    store_name,
    worker_id,
    worker_email,
    changed_fields,
    old_data,
    new_data,
    summary,
    reason,
    signed_by,
    signed_by_email,
    verified_method,
    verified_at
  )
  values (
    tg_table_name,
    v_record_id,
    v_action,
    v_item_id,
    v_item_title,
    v_item_barcode,
    v_location_id,
    v_location_name,
    v_store_id,
    v_store_name,
    v_worker_id,
    v_worker_email,
    v_changed_fields,
    nullif(v_old, '{}'::jsonb),
    nullif(v_new, '{}'::jsonb),
    v_summary,
    v_reason,
    v_worker_id,
    coalesce(v_signed_by_email, v_worker_email),
    v_verified_method,
    v_verified_at
  );

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

create or replace function public.update_certified_item_details(
  _item_id uuid,
  _title text,
  _description text,
  _weight numeric,
  _stone_type text,
  _item_length text,
  _qr_type text default null,
  _qr_code text default null,
  _cost numeric default null,
  _sale_price numeric default null,
  _price_per_weight numeric default null,
  _stock_batch_size_update numeric default null,
  _dymo_label_url text default null,
  _photos text[] default null,
  _reason text default null,
  _signed_by_email text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.item_types;
  v_updated_id uuid;
  v_is_admin boolean := public.is_admin();
  v_reason text := nullif(btrim(coalesce(_reason, '')), '');
  v_verified_at timestamptz := now();
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to edit inventory items' using errcode = '42501';
  end if;

  if _item_id is null then
    raise exception 'Item id is required' using errcode = '22023';
  end if;

  if nullif(btrim(coalesce(_title, '')), '') is null then
    raise exception 'Title is required' using errcode = '22023';
  end if;

  if v_reason is null or length(v_reason) < 3 then
    raise exception 'A brief reason for the edit is required' using errcode = '22023';
  end if;

  select *
    into v_existing
  from public.item_types
  where id = _item_id
  for update;

  if not found then
    raise exception 'Item not found' using errcode = 'P0002';
  end if;

  perform set_config('app.inventory_change_reason', v_reason, true);
  perform set_config('app.inventory_change_signed_by_email', coalesce(_signed_by_email, ''), true);
  perform set_config('app.inventory_change_verified_method', 'password', true);
  perform set_config('app.inventory_change_verified_at', v_verified_at::text, true);

  update public.item_types
  set
    title = btrim(_title),
    description = coalesce(_description, ''),
    weight = coalesce(_weight, 0),
    stone_type = nullif(btrim(coalesce(_stone_type, '')), ''),
    item_length = nullif(btrim(coalesce(_item_length, '')), ''),
    qr_type = case when v_is_admin then _qr_type else v_existing.qr_type end,
    qr_code = case when v_is_admin then _qr_code else v_existing.qr_code end,
    cost = case when v_is_admin then coalesce(_cost, 0) else v_existing.cost end,
    sale_price = case when v_is_admin then coalesce(_sale_price, 0) else v_existing.sale_price end,
    price_per_weight = case when v_is_admin then coalesce(_price_per_weight, 0) else v_existing.price_per_weight end,
    stock_batch_size_update = case when v_is_admin then coalesce(_stock_batch_size_update, 0) else v_existing.stock_batch_size_update end,
    dymo_label_url = case when v_is_admin then coalesce(_dymo_label_url, v_existing.dymo_label_url) else v_existing.dymo_label_url end,
    photos = case when v_is_admin and _photos is not null then _photos else v_existing.photos end
  where id = _item_id
  returning id into v_updated_id;

  return v_updated_id;
end;
$$;

revoke all on function public.update_certified_item_details(
  uuid, text, text, numeric, text, text, text, text, numeric, numeric, numeric, numeric, text, text[], text, text
) from public;

grant execute on function public.update_certified_item_details(
  uuid, text, text, numeric, text, text, text, text, numeric, numeric, numeric, numeric, text, text[], text, text
) to authenticated;
