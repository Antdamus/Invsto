alter table public.item_stock_locations
  add column if not exists condition_status text not null default 'good',
  add column if not exists condition_reason text,
  add column if not exists condition_notes text,
  add column if not exists condition_updated_at timestamptz,
  add column if not exists condition_updated_by uuid references auth.users(id) on delete set null;

alter table public.item_stock_locations
  drop constraint if exists item_stock_locations_condition_status_check;

alter table public.item_stock_locations
  add constraint item_stock_locations_condition_status_check
  check (condition_status in ('good', 'defective'));

update public.item_stock_locations
set condition_status = 'good'
where condition_status is null;

create index if not exists idx_item_stock_locations_condition
  on public.item_stock_locations (item_id, condition_status, location_id)
  where quantity > 0;

alter table public.stock_transactions
  add column if not exists stock_condition text,
  add column if not exists source_stock_location_row_id uuid references public.item_stock_locations(id) on delete set null,
  add column if not exists destination_location_id uuid references public.locations(id) on delete set null,
  add column if not exists destination_stock_location_row_id uuid references public.item_stock_locations(id) on delete set null,
  add column if not exists defect_reason text,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.stock_transactions
  drop constraint if exists stock_transactions_stock_condition_check;

alter table public.stock_transactions
  add constraint stock_transactions_stock_condition_check
  check (stock_condition is null or stock_condition in ('good', 'defective'));

create or replace function public.add_defective_inventory(
  _item_id uuid,
  _destination_location_id uuid,
  _quantity integer,
  _defect_reason text default null,
  _notes text default null,
  _user_id uuid default null,
  _email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.item_types;
  v_destination public.locations;
  v_dest public.item_stock_locations;
  v_qty integer := coalesce(_quantity, 0);
  v_now timestamptz := now();
  v_reason text := nullif(btrim(coalesce(_defect_reason, '')), '');
  v_notes text := nullif(btrim(coalesce(_notes, '')), '');
  v_email text := nullif(btrim(coalesce(_email, '')), '');
  v_user_id uuid := coalesce(_user_id, auth.uid());
  v_tx_id uuid;
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to manage defective inventory' using errcode = '42501';
  end if;

  if v_qty <= 0 then
    raise exception 'Quantity must be greater than zero' using errcode = '22023';
  end if;

  if v_reason is null then
    raise exception 'A defect reason is required' using errcode = '22023';
  end if;

  select * into v_item
  from public.item_types
  where id = _item_id;

  if not found then
    raise exception 'Item not found' using errcode = 'P0002';
  end if;

  select * into v_destination
  from public.locations
  where id = _destination_location_id
    and coalesce(active, true) is true;

  if not found then
    raise exception 'Destination location not found or inactive' using errcode = 'P0002';
  end if;

  select * into v_dest
  from public.item_stock_locations
  where item_id = _item_id
    and location_id = _destination_location_id
    and condition_status = 'defective'
  order by confirmed_at nulls last, id
  limit 1
  for update;

  if found then
    update public.item_stock_locations
    set quantity = coalesce(quantity, 0) + v_qty,
        last_updated = v_now,
        added_by = v_user_id,
        confirmation_email = coalesce(v_email, confirmation_email),
        confirmation_method = 'defective_inventory_checkin',
        confirmed_at = v_now,
        condition_status = 'defective',
        condition_reason = v_reason,
        condition_notes = v_notes,
        condition_updated_at = v_now,
        condition_updated_by = v_user_id
    where id = v_dest.id
    returning * into v_dest;
  else
    insert into public.item_stock_locations (
      item_id,
      location_id,
      quantity,
      added_by,
      confirmation_email,
      confirmation_method,
      confirmed_at,
      last_updated,
      condition_status,
      condition_reason,
      condition_notes,
      condition_updated_at,
      condition_updated_by
    )
    values (
      _item_id,
      _destination_location_id,
      v_qty,
      v_user_id,
      v_email,
      'defective_inventory_checkin',
      v_now,
      v_now,
      'defective',
      v_reason,
      v_notes,
      v_now,
      v_user_id
    )
    returning * into v_dest;
  end if;

  insert into public.stock_transactions (
    item_id,
    location_id,
    quantity,
    action_type,
    confirmed_at,
    user_id,
    email,
    notes,
    method,
    timestamp,
    stock_condition,
    destination_location_id,
    destination_stock_location_row_id,
    defect_reason,
    metadata
  )
  values (
    _item_id,
    _destination_location_id,
    v_qty,
    'checkin',
    v_now,
    v_user_id,
    v_email,
    concat_ws(' | ', 'Incoming defective inventory', 'reason: ' || v_reason, v_notes),
    'defective_inventory_checkin',
    v_now,
    'defective',
    _destination_location_id,
    v_dest.id,
    v_reason,
    jsonb_build_object('destination_condition', 'defective')
  )
  returning id into v_tx_id;

  return jsonb_build_object(
    'item_id', _item_id,
    'destination_stock_location_row_id', v_dest.id,
    'quantity', v_qty,
    'transaction_id', v_tx_id,
    'condition_status', 'defective'
  );
end;
$$;

create or replace function public.move_stock_condition(
  _source_stock_location_row_id uuid,
  _destination_location_id uuid,
  _quantity integer,
  _destination_condition text,
  _defect_reason text default null,
  _notes text default null,
  _user_id uuid default null,
  _email text default null,
  _method text default 'defect_transfer'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source public.item_stock_locations;
  v_destination public.locations;
  v_dest public.item_stock_locations;
  v_qty integer := coalesce(_quantity, 0);
  v_now timestamptz := now();
  v_source_condition text;
  v_destination_condition text := lower(nullif(btrim(coalesce(_destination_condition, '')), ''));
  v_reason text := nullif(btrim(coalesce(_defect_reason, '')), '');
  v_notes text := nullif(btrim(coalesce(_notes, '')), '');
  v_email text := nullif(btrim(coalesce(_email, '')), '');
  v_user_id uuid := coalesce(_user_id, auth.uid());
  v_source_tx_id uuid;
  v_dest_tx_id uuid;
  v_method text := nullif(btrim(coalesce(_method, '')), '');
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to manage defective inventory' using errcode = '42501';
  end if;

  if v_qty <= 0 then
    raise exception 'Quantity must be greater than zero' using errcode = '22023';
  end if;

  if v_destination_condition not in ('good', 'defective') then
    raise exception 'Destination condition must be good or defective' using errcode = '22023';
  end if;

  select * into v_source
  from public.item_stock_locations
  where id = _source_stock_location_row_id
  for update;

  if not found then
    raise exception 'Source stock row not found' using errcode = 'P0002';
  end if;

  v_source_condition := coalesce(v_source.condition_status, 'good');

  if coalesce(v_source.quantity, 0) < v_qty then
    raise exception 'Only % available at source', coalesce(v_source.quantity, 0) using errcode = '22023';
  end if;

  if v_source_condition = v_destination_condition and v_source.location_id = _destination_location_id then
    raise exception 'Source and destination are the same stock lane' using errcode = '22023';
  end if;

  if v_destination_condition = 'defective' and v_reason is null then
    raise exception 'A defect reason is required' using errcode = '22023';
  end if;

  select * into v_destination
  from public.locations
  where id = _destination_location_id
    and coalesce(active, true) is true;

  if not found then
    raise exception 'Destination location not found or inactive' using errcode = 'P0002';
  end if;

  update public.item_stock_locations
  set quantity = coalesce(quantity, 0) - v_qty,
      last_updated = v_now,
      added_by = v_user_id,
      confirmation_email = coalesce(v_email, confirmation_email),
      confirmation_method = v_method,
      confirmed_at = v_now,
      locked_by = null,
      locked_at = null
  where id = v_source.id
  returning * into v_source;

  select * into v_dest
  from public.item_stock_locations
  where item_id = v_source.item_id
    and location_id = _destination_location_id
    and condition_status = v_destination_condition
  order by confirmed_at nulls last, id
  limit 1
  for update;

  if found then
    update public.item_stock_locations
    set quantity = coalesce(quantity, 0) + v_qty,
        last_updated = v_now,
        added_by = v_user_id,
        confirmation_email = coalesce(v_email, confirmation_email),
        confirmation_method = v_method,
        confirmed_at = v_now,
        condition_status = v_destination_condition,
        condition_reason = case when v_destination_condition = 'defective' then v_reason else null end,
        condition_notes = case when v_destination_condition = 'defective' then v_notes else null end,
        condition_updated_at = v_now,
        condition_updated_by = v_user_id
    where id = v_dest.id
    returning * into v_dest;
  else
    insert into public.item_stock_locations (
      item_id,
      location_id,
      quantity,
      added_by,
      confirmation_email,
      confirmation_method,
      confirmed_at,
      last_updated,
      condition_status,
      condition_reason,
      condition_notes,
      condition_updated_at,
      condition_updated_by
    )
    values (
      v_source.item_id,
      _destination_location_id,
      v_qty,
      v_user_id,
      v_email,
      v_method,
      v_now,
      v_now,
      v_destination_condition,
      case when v_destination_condition = 'defective' then v_reason else null end,
      case when v_destination_condition = 'defective' then v_notes else null end,
      v_now,
      v_user_id
    )
    returning * into v_dest;
  end if;

  insert into public.stock_transactions (
    item_id,
    location_id,
    quantity,
    action_type,
    confirmed_at,
    user_id,
    email,
    notes,
    method,
    timestamp,
    stock_condition,
    source_stock_location_row_id,
    destination_location_id,
    destination_stock_location_row_id,
    defect_reason,
    metadata
  )
  values (
    v_source.item_id,
    v_source.location_id,
    -v_qty,
    'transfer',
    v_now,
    v_user_id,
    v_email,
    concat_ws(' | ', 'Condition transfer source', v_source_condition || ' -> ' || v_destination_condition, 'reason: ' || v_reason, v_notes),
    v_method,
    v_now,
    v_source_condition,
    v_source.id,
    _destination_location_id,
    v_dest.id,
    v_reason,
    jsonb_build_object('source_condition', v_source_condition, 'destination_condition', v_destination_condition)
  )
  returning id into v_source_tx_id;

  insert into public.stock_transactions (
    item_id,
    location_id,
    quantity,
    action_type,
    confirmed_at,
    user_id,
    email,
    notes,
    source_transaction_id,
    method,
    timestamp,
    stock_condition,
    source_stock_location_row_id,
    destination_location_id,
    destination_stock_location_row_id,
    defect_reason,
    metadata
  )
  values (
    v_source.item_id,
    _destination_location_id,
    v_qty,
    'transfer',
    v_now,
    v_user_id,
    v_email,
    concat_ws(' | ', 'Condition transfer destination', v_source_condition || ' -> ' || v_destination_condition, 'reason: ' || v_reason, v_notes),
    v_source_tx_id,
    v_method,
    v_now,
    v_destination_condition,
    v_source.id,
    _destination_location_id,
    v_dest.id,
    v_reason,
    jsonb_build_object('source_condition', v_source_condition, 'destination_condition', v_destination_condition)
  )
  returning id into v_dest_tx_id;

  return jsonb_build_object(
    'item_id', v_source.item_id,
    'source_stock_location_row_id', v_source.id,
    'destination_stock_location_row_id', v_dest.id,
    'source_location_id', v_source.location_id,
    'destination_location_id', _destination_location_id,
    'source_condition', v_source_condition,
    'destination_condition', v_destination_condition,
    'quantity', v_qty,
    'source_transaction_id', v_source_tx_id,
    'destination_transaction_id', v_dest_tx_id
  );
end;
$$;

revoke all on function public.add_defective_inventory(uuid, uuid, integer, text, text, uuid, text) from public;
grant execute on function public.add_defective_inventory(uuid, uuid, integer, text, text, uuid, text) to authenticated;

revoke all on function public.move_stock_condition(uuid, uuid, integer, text, text, text, uuid, text, text) from public;
grant execute on function public.move_stock_condition(uuid, uuid, integer, text, text, text, uuid, text, text) to authenticated;
