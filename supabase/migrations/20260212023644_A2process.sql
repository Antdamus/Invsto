-- ===============================
-- Reservations (10-minute holds)
-- ===============================

create table public.reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid null references auth.users(id) on delete set null,
  anon_session_id text null,
  status text not null default 'active' check (status in ('active','expired','paid')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index idx_reservations_status_expires
on public.reservations(status, expires_at);

-- ===============================
-- Reservation Items
-- ===============================

create table public.reservation_items (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations(id) on delete cascade,
  item_type_id uuid not null references public.item_types(id),
  quantity integer not null check (quantity > 0)
);

create index idx_reservation_items_item
on public.reservation_items(item_type_id);

create or replace function public.get_available_quantity(p_item_id uuid)
returns integer
language plpgsql
as $$
declare
  v_total integer;
  v_reserved integer;
begin
  -- Total physical stock
  select coalesce(sum(quantity),0)
  into v_total
  from public.item_stock_locations
  where item_id = p_item_id;

  -- Active reservations
  select coalesce(sum(ri.quantity),0)
  into v_reserved
  from public.reservation_items ri
  join public.reservations r on r.id = ri.reservation_id
  where ri.item_type_id = p_item_id
    and r.status = 'active'
    and r.expires_at > now();

  return v_total - v_reserved;
end;
$$;

create or replace function public.create_reservation(
  p_items jsonb,
  p_user_id uuid default null,
  p_anon_session_id text default null
)
returns uuid
language plpgsql
as $$
declare
  v_reservation_id uuid;
  v_item jsonb;
  v_item_id uuid;
  v_qty integer;
  v_available integer;
begin

  -- Create reservation row first
  insert into public.reservations (
    user_id,
    anon_session_id,
    expires_at
  )
  values (
    p_user_id,
    p_anon_session_id,
    now() + interval '10 minutes'
  )
  returning id into v_reservation_id;

  -- Loop through cart items
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_item_id := (v_item->>'id')::uuid;
    v_qty := (v_item->>'qty')::integer;

    -- Lock item row to prevent race conditions
    perform 1 from public.item_types
    where id = v_item_id
    for update;

    -- Compute availability
    select public.get_available_quantity(v_item_id)
    into v_available;

    if v_available < v_qty then
      raise exception 'Insufficient stock for item %', v_item_id;
    end if;

    insert into public.reservation_items (
      reservation_id,
      item_type_id,
      quantity
    )
    values (
      v_reservation_id,
      v_item_id,
      v_qty
    );
  end loop;

  return v_reservation_id;
end;
$$;
