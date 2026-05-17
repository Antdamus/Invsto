-- Inter-store custody transfers.
-- Source stock is removed into an "in transfer" layer when the bundle leaves a
-- store, then restored into the destination store when the receiver places it.

create table if not exists public.store_transfers (
  id uuid primary key default gen_random_uuid(),
  transfer_number text not null unique default ('TR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))),
  source_store_id uuid not null references public.store_locations(id) on delete restrict,
  destination_store_id uuid not null references public.store_locations(id) on delete restrict,
  status text not null default 'pending_receipt'
    check (status in ('draft', 'pending_receipt', 'partially_received', 'completed', 'cancelled', 'exception')),
  sender_user_id uuid references auth.users(id) on delete set null,
  sender_email text,
  sender_signed_at timestamptz,
  receiver_user_id uuid references auth.users(id) on delete set null,
  receiver_email text,
  receiver_signed_at timestamptz,
  evidence_photos text[] not null default '{}'::text[],
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  cancelled_at timestamptz,
  exception_at timestamptz,
  source_gps_latitude numeric,
  source_gps_longitude numeric,
  source_gps_accuracy_meters numeric,
  source_gps_captured_at timestamptz,
  source_gps_status text,
  receive_gps_latitude numeric,
  receive_gps_longitude numeric,
  receive_gps_accuracy_meters numeric,
  receive_gps_captured_at timestamptz,
  receive_gps_status text,
  constraint store_transfers_distinct_stores check (source_store_id <> destination_store_id)
);

create table if not exists public.store_transfer_items (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references public.store_transfers(id) on delete cascade,
  item_id uuid not null references public.item_types(id) on delete restrict,
  source_stock_location_row_id uuid references public.item_stock_locations(id) on delete set null,
  source_location_id uuid not null references public.locations(id) on delete restrict,
  source_store_id uuid not null references public.store_locations(id) on delete restrict,
  quantity_requested integer not null check (quantity_requested > 0),
  quantity_received integer not null default 0 check (quantity_received >= 0),
  destination_location_id uuid references public.locations(id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending', 'partially_received', 'received', 'cancelled', 'exception')),
  notes text,
  source_stock_transaction_id uuid references public.stock_transactions(id) on delete set null,
  receive_stock_transaction_id uuid references public.stock_transactions(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.store_transfer_events (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references public.store_transfers(id) on delete cascade,
  transfer_item_id uuid references public.store_transfer_items(id) on delete cascade,
  action text not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_email text,
  notes text,
  payload jsonb not null default '{}'::jsonb,
  gps_latitude numeric,
  gps_longitude numeric,
  gps_accuracy_meters numeric,
  gps_captured_at timestamptz,
  gps_status text,
  created_at timestamptz not null default now()
);

create index if not exists store_transfers_status_idx
  on public.store_transfers(status, created_at desc);
create index if not exists store_transfers_receiver_idx
  on public.store_transfers(receiver_user_id, status, created_at desc);
create index if not exists store_transfer_items_transfer_idx
  on public.store_transfer_items(transfer_id, status);
create index if not exists store_transfer_events_transfer_idx
  on public.store_transfer_events(transfer_id, created_at desc);

alter table public.store_transfers enable row level security;
alter table public.store_transfer_items enable row level security;
alter table public.store_transfer_events enable row level security;

drop policy if exists "store_transfers_inventory_select" on public.store_transfers;
drop policy if exists "store_transfer_items_inventory_select" on public.store_transfer_items;
drop policy if exists "store_transfer_events_inventory_select" on public.store_transfer_events;

create policy "store_transfers_inventory_select"
on public.store_transfers
for select
to authenticated
using (public.can_manage_inventory());

create policy "store_transfer_items_inventory_select"
on public.store_transfer_items
for select
to authenticated
using (public.can_manage_inventory());

create policy "store_transfer_events_inventory_select"
on public.store_transfer_events
for select
to authenticated
using (public.can_manage_inventory());

create or replace function public.store_transfer_location_store_id(_location_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(l.tray_current_store_id, l.store_id, p.store_id)
  from public.locations l
  left join public.locations p on p.id = l.parent_location_id
  where l.id = _location_id
$$;

create or replace function public.store_transfer_log_event(
  _transfer_id uuid,
  _transfer_item_id uuid,
  _action text,
  _actor_email text default null,
  _notes text default null,
  _payload jsonb default '{}'::jsonb,
  _gps_latitude numeric default null,
  _gps_longitude numeric default null,
  _gps_accuracy_meters numeric default null,
  _gps_captured_at timestamptz default null,
  _gps_status text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into public.store_transfer_events (
    transfer_id,
    transfer_item_id,
    action,
    actor_user_id,
    actor_email,
    notes,
    payload,
    gps_latitude,
    gps_longitude,
    gps_accuracy_meters,
    gps_captured_at,
    gps_status
  )
  values (
    _transfer_id,
    _transfer_item_id,
    _action,
    auth.uid(),
    nullif(btrim(coalesce(_actor_email, '')), ''),
    nullif(btrim(coalesce(_notes, '')), ''),
    coalesce(_payload, '{}'::jsonb),
    _gps_latitude,
    _gps_longitude,
    _gps_accuracy_meters,
    _gps_captured_at,
    coalesce(nullif(btrim(coalesce(_gps_status, '')), ''), 'not_requested')
  )
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.create_store_transfer(
  _source_store_id uuid,
  _destination_store_id uuid,
  _receiver_user_id uuid,
  _sender_email text,
  _receiver_email text,
  _items jsonb,
  _evidence_photos text[] default '{}'::text[],
  _notes text default null,
  _gps_latitude numeric default null,
  _gps_longitude numeric default null,
  _gps_accuracy_meters numeric default null,
  _gps_captured_at timestamptz default null,
  _gps_status text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_transfer_id uuid;
  v_entry jsonb;
  v_source public.item_stock_locations%rowtype;
  v_source_store uuid;
  v_qty integer;
  v_item_id uuid;
  v_tx_id uuid;
  v_item_row_id uuid;
  v_sender_email text := nullif(btrim(coalesce(_sender_email, '')), '');
  v_receiver_email text := nullif(btrim(coalesce(_receiver_email, '')), '');
  v_notes text := nullif(btrim(coalesce(_notes, '')), '');
  v_gps_status text := coalesce(nullif(btrim(coalesce(_gps_status, '')), ''), 'not_requested');
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to create store transfers' using errcode = '42501';
  end if;

  if _source_store_id is null or _destination_store_id is null or _receiver_user_id is null then
    raise exception 'Source store, destination store, and receiver are required' using errcode = '22023';
  end if;

  if _source_store_id = _destination_store_id then
    raise exception 'Destination store must be different from source store' using errcode = '22023';
  end if;

  if coalesce(jsonb_array_length(coalesce(_items, '[]'::jsonb)), 0) = 0 then
    raise exception 'Add at least one item to transfer' using errcode = '22023';
  end if;

  if not exists (select 1 from public.employees where user_id = _receiver_user_id and active is distinct from false) then
    raise exception 'Receiver must be an active user' using errcode = '22023';
  end if;

  insert into public.store_transfers (
    source_store_id,
    destination_store_id,
    status,
    sender_user_id,
    sender_email,
    sender_signed_at,
    receiver_user_id,
    receiver_email,
    receiver_signed_at,
    evidence_photos,
    notes,
    source_gps_latitude,
    source_gps_longitude,
    source_gps_accuracy_meters,
    source_gps_captured_at,
    source_gps_status
  )
  values (
    _source_store_id,
    _destination_store_id,
    'pending_receipt',
    auth.uid(),
    v_sender_email,
    now(),
    _receiver_user_id,
    v_receiver_email,
    now(),
    coalesce(_evidence_photos, '{}'::text[]),
    v_notes,
    _gps_latitude,
    _gps_longitude,
    _gps_accuracy_meters,
    _gps_captured_at,
    v_gps_status
  )
  returning id into v_transfer_id;

  for v_entry in select * from jsonb_array_elements(_items) loop
    v_item_id := nullif(v_entry ->> 'item_id', '')::uuid;
    v_qty := coalesce((v_entry ->> 'quantity')::integer, 0);

    select *
      into v_source
    from public.item_stock_locations
    where id = nullif(v_entry ->> 'source_stock_location_row_id', '')::uuid
    for update;

    if not found then
      raise exception 'Source stock row was not found' using errcode = 'P0002';
    end if;

    if v_source.item_id is distinct from v_item_id then
      raise exception 'Scanned item does not match the selected source row' using errcode = '22023';
    end if;

    if v_qty <= 0 or coalesce(v_source.quantity, 0) < v_qty then
      raise exception 'Only % unit(s) are available from this source', coalesce(v_source.quantity, 0) using errcode = '22023';
    end if;

    v_source_store := public.store_transfer_location_store_id(v_source.location_id);
    if v_source_store is distinct from _source_store_id then
      raise exception 'Source location is not in the selected source store' using errcode = '22023';
    end if;

    update public.item_stock_locations
    set quantity = quantity - v_qty,
        last_updated = now(),
        added_by = auth.uid(),
        confirmation_email = coalesce(v_sender_email, confirmation_email),
        confirmation_method = 'interstore_transfer_out',
        confirmed_at = now(),
        locked_by = null,
        locked_at = null
    where id = v_source.id
    returning * into v_source;

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
      timestamp
    )
    values (
      v_item_id,
      v_source.location_id,
      -v_qty,
      'transfer',
      now(),
      auth.uid(),
      v_sender_email,
      coalesce(v_notes, 'Inter-store transfer checkout'),
      'interstore_transfer_out',
      now()
    )
    returning id into v_tx_id;

    insert into public.store_transfer_items (
      transfer_id,
      item_id,
      source_stock_location_row_id,
      source_location_id,
      source_store_id,
      quantity_requested,
      notes,
      source_stock_transaction_id
    )
    values (
      v_transfer_id,
      v_item_id,
      v_source.id,
      v_source.location_id,
      _source_store_id,
      v_qty,
      v_notes,
      v_tx_id
    )
    returning id into v_item_row_id;

    perform public.store_transfer_log_event(
      v_transfer_id,
      v_item_row_id,
      'item_checked_out',
      v_sender_email,
      v_notes,
      jsonb_build_object(
        'item_id', v_item_id,
        'source_stock_location_row_id', v_source.id,
        'source_location_id', v_source.location_id,
        'quantity', v_qty,
        'stock_transaction_id', v_tx_id
      ),
      _gps_latitude,
      _gps_longitude,
      _gps_accuracy_meters,
      _gps_captured_at,
      v_gps_status
    );
  end loop;

  perform public.store_transfer_log_event(
    v_transfer_id,
    null,
    'transfer_created',
    v_sender_email,
    v_notes,
    jsonb_build_object(
      'source_store_id', _source_store_id,
      'destination_store_id', _destination_store_id,
      'receiver_user_id', _receiver_user_id,
      'receiver_email', v_receiver_email,
      'evidence_photos', coalesce(_evidence_photos, '{}'::text[])
    ),
    _gps_latitude,
    _gps_longitude,
    _gps_accuracy_meters,
    _gps_captured_at,
    v_gps_status
  );

  update public.metadata
  set inventory_version = gen_random_uuid()::text,
      changed_item_ids = (
        select array_agg(distinct item_id::text)
        from public.store_transfer_items
        where transfer_id = v_transfer_id
      ),
      updated_at = now()
  where id = 'inventory';

  return v_transfer_id;
end;
$$;

create or replace function public.receive_store_transfer_items(
  _transfer_id uuid,
  _placements jsonb,
  _signed_by_email text default null,
  _notes text default null,
  _gps_latitude numeric default null,
  _gps_longitude numeric default null,
  _gps_accuracy_meters numeric default null,
  _gps_captured_at timestamptz default null,
  _gps_status text default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_transfer public.store_transfers%rowtype;
  v_entry jsonb;
  v_item public.store_transfer_items%rowtype;
  v_dest public.item_stock_locations%rowtype;
  v_dest_store uuid;
  v_qty integer;
  v_tx_id uuid;
  v_received integer := 0;
  v_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
  v_notes text := nullif(btrim(coalesce(_notes, '')), '');
  v_gps_status text := coalesce(nullif(btrim(coalesce(_gps_status, '')), ''), 'not_requested');
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to receive store transfers' using errcode = '42501';
  end if;

  select *
    into v_transfer
  from public.store_transfers
  where id = _transfer_id
  for update;

  if not found then
    raise exception 'Transfer not found' using errcode = 'P0002';
  end if;

  if v_transfer.status in ('completed', 'cancelled') then
    raise exception 'This transfer is already closed' using errcode = '22023';
  end if;

  if auth.uid() is distinct from v_transfer.receiver_user_id and not public.is_admin() then
    raise exception 'Only the assigned receiver or an admin can receive this transfer' using errcode = '42501';
  end if;

  if coalesce(jsonb_array_length(coalesce(_placements, '[]'::jsonb)), 0) = 0 then
    raise exception 'Add at least one placement to receive' using errcode = '22023';
  end if;

  for v_entry in select * from jsonb_array_elements(_placements) loop
    v_qty := coalesce((v_entry ->> 'quantity')::integer, 0);

    select *
      into v_item
    from public.store_transfer_items
    where id = nullif(v_entry ->> 'transfer_item_id', '')::uuid
      and transfer_id = _transfer_id
    for update;

    if not found then
      raise exception 'Transfer item not found' using errcode = 'P0002';
    end if;

    if v_item.status in ('received', 'cancelled') then
      continue;
    end if;

    if v_qty <= 0 or v_qty > (v_item.quantity_requested - v_item.quantity_received) then
      raise exception 'Invalid received quantity for transfer item' using errcode = '22023';
    end if;

    v_dest_store := public.store_transfer_location_store_id(nullif(v_entry ->> 'destination_location_id', '')::uuid);
    if v_dest_store is distinct from v_transfer.destination_store_id then
      raise exception 'Destination location is not in the transfer destination store' using errcode = '22023';
    end if;

    select *
      into v_dest
    from public.item_stock_locations
    where item_id = v_item.item_id
      and location_id = nullif(v_entry ->> 'destination_location_id', '')::uuid
    for update;

    if found then
      update public.item_stock_locations
      set quantity = quantity + v_qty,
          last_updated = now(),
          added_by = auth.uid(),
          confirmation_email = coalesce(v_email, confirmation_email),
          confirmation_method = 'interstore_transfer_in',
          confirmed_at = now()
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
        last_updated
      )
      values (
        v_item.item_id,
        nullif(v_entry ->> 'destination_location_id', '')::uuid,
        v_qty,
        auth.uid(),
        v_email,
        'interstore_transfer_in',
        now(),
        now()
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
      timestamp
    )
    values (
      v_item.item_id,
      v_dest.location_id,
      v_qty,
      'transfer',
      now(),
      auth.uid(),
      v_email,
      coalesce(v_notes, 'Inter-store transfer receipt'),
      'interstore_transfer_in',
      now()
    )
    returning id into v_tx_id;

    update public.store_transfer_items
    set quantity_received = quantity_received + v_qty,
        destination_location_id = v_dest.location_id,
        status = case
          when quantity_received + v_qty >= quantity_requested then 'received'
          else 'partially_received'
        end,
        receive_stock_transaction_id = v_tx_id,
        notes = coalesce(v_notes, notes),
        updated_at = now()
    where id = v_item.id;

    perform public.store_transfer_log_event(
      _transfer_id,
      v_item.id,
      'item_received',
      v_email,
      v_notes,
      jsonb_build_object(
        'item_id', v_item.item_id,
        'destination_location_id', v_dest.location_id,
        'quantity', v_qty,
        'stock_transaction_id', v_tx_id
      ),
      _gps_latitude,
      _gps_longitude,
      _gps_accuracy_meters,
      _gps_captured_at,
      v_gps_status
    );

    v_received := v_received + v_qty;
  end loop;

  update public.store_transfers
  set status = case
        when exists (
          select 1 from public.store_transfer_items
          where transfer_id = _transfer_id
            and status in ('pending', 'partially_received')
        ) then 'partially_received'
        else 'completed'
      end,
      completed_at = case
        when not exists (
          select 1 from public.store_transfer_items
          where transfer_id = _transfer_id
            and status in ('pending', 'partially_received')
        ) then now()
        else completed_at
      end,
      receive_gps_latitude = _gps_latitude,
      receive_gps_longitude = _gps_longitude,
      receive_gps_accuracy_meters = _gps_accuracy_meters,
      receive_gps_captured_at = _gps_captured_at,
      receive_gps_status = v_gps_status,
      updated_at = now()
  where id = _transfer_id;

  update public.metadata
  set inventory_version = gen_random_uuid()::text,
      changed_item_ids = (
        select array_agg(distinct item_id::text)
        from public.store_transfer_items
        where transfer_id = _transfer_id
      ),
      updated_at = now()
  where id = 'inventory';

  return v_received;
end;
$$;

create or replace function public.mark_store_transfer_exception(
  _transfer_id uuid,
  _transfer_item_id uuid default null,
  _notes text default null,
  _signed_by_email text default null,
  _gps_latitude numeric default null,
  _gps_longitude numeric default null,
  _gps_accuracy_meters numeric default null,
  _gps_captured_at timestamptz default null,
  _gps_status text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to mark transfer exceptions' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.store_transfers st
    where st.id = _transfer_id
      and (st.receiver_user_id is not distinct from auth.uid() or public.is_admin())
  ) then
    raise exception 'Only the assigned receiver or an admin can mark an exception' using errcode = '42501';
  end if;

  update public.store_transfers
  set status = 'exception',
      exception_at = now(),
      updated_at = now()
  where id = _transfer_id;

  if _transfer_item_id is not null then
    update public.store_transfer_items
    set status = 'exception',
        notes = coalesce(nullif(btrim(coalesce(_notes, '')), ''), notes),
        updated_at = now()
    where id = _transfer_item_id
      and transfer_id = _transfer_id;
  end if;

  perform public.store_transfer_log_event(
    _transfer_id,
    _transfer_item_id,
    'exception_reported',
    v_email,
    _notes,
    '{}'::jsonb,
    _gps_latitude,
    _gps_longitude,
    _gps_accuracy_meters,
    _gps_captured_at,
    _gps_status
  );
end;
$$;

revoke all on function public.store_transfer_location_store_id(uuid) from public;
revoke all on function public.store_transfer_log_event(uuid, uuid, text, text, text, jsonb, numeric, numeric, numeric, timestamptz, text) from public;
revoke all on function public.create_store_transfer(uuid, uuid, uuid, text, text, jsonb, text[], text, numeric, numeric, numeric, timestamptz, text) from public;
revoke all on function public.receive_store_transfer_items(uuid, jsonb, text, text, numeric, numeric, numeric, timestamptz, text) from public;
revoke all on function public.mark_store_transfer_exception(uuid, uuid, text, text, numeric, numeric, numeric, timestamptz, text) from public;

grant execute on function public.store_transfer_location_store_id(uuid) to authenticated;
grant execute on function public.create_store_transfer(uuid, uuid, uuid, text, text, jsonb, text[], text, numeric, numeric, numeric, timestamptz, text) to authenticated;
grant execute on function public.receive_store_transfer_items(uuid, jsonb, text, text, numeric, numeric, numeric, timestamptz, text) to authenticated;
grant execute on function public.mark_store_transfer_exception(uuid, uuid, text, text, numeric, numeric, numeric, timestamptz, text) to authenticated;
