-- Track non-inventory/general live-sale items inside auction bags.
-- These entries do not reserve stock. They only preserve the live auction count
-- and description when an item is sold before it exists in inventory.

create table if not exists public.live_sale_manual_lot_items (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references public.live_sale_lots(id) on delete cascade,
  session_id uuid not null references public.live_sale_sessions(id) on delete cascade,
  item_category text not null,
  item_description text,
  quantity integer not null default 1 check (quantity > 0),
  status text not null default 'reserved'
    check (status in ('reserved', 'packed', 'released', 'cancelled', 'reverted')),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_by_email text,
  created_at timestamptz not null default now(),
  show_elapsed_seconds integer,
  packed_order_line_id uuid references public.ebay_order_lines(id) on delete set null,
  packed_at timestamptz,
  notes text
);

create index if not exists live_sale_manual_lot_items_lot_status_idx
  on public.live_sale_manual_lot_items(lot_id, status, created_at);

create index if not exists live_sale_manual_lot_items_session_idx
  on public.live_sale_manual_lot_items(session_id, created_at);

alter table public.live_sale_manual_lot_items enable row level security;

drop policy if exists "live_sale_manual_lot_items_inventory_select" on public.live_sale_manual_lot_items;
create policy "live_sale_manual_lot_items_inventory_select"
on public.live_sale_manual_lot_items
for select
to authenticated
using (public.can_manage_inventory());

drop policy if exists "live_sale_manual_lot_items_inventory_write" on public.live_sale_manual_lot_items;
create policy "live_sale_manual_lot_items_inventory_write"
on public.live_sale_manual_lot_items
for all
to authenticated
using (public.can_manage_inventory())
with check (public.can_manage_inventory());

grant select, insert, update on table public.live_sale_manual_lot_items to authenticated;

create or replace function public.add_live_sale_manual_lot_item(
  _lot_id uuid,
  _category text,
  _description text default null,
  _quantity integer default 1,
  _signed_by_email text default null,
  _notes text default null
)
returns public.live_sale_manual_lot_items
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lot public.live_sale_lots;
  v_item public.live_sale_manual_lot_items;
  v_category text := nullif(btrim(coalesce(_category, '')), '');
  v_description text := nullif(btrim(coalesce(_description, '')), '');
  v_quantity integer := greatest(1, coalesce(_quantity, 1));
  v_elapsed integer := null;
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to add manual live sale items' using errcode = '42501';
  end if;

  if _lot_id is null then
    raise exception 'Auction bag is required' using errcode = '22023';
  end if;

  if v_category is null then
    raise exception 'General item category is required' using errcode = '22023';
  end if;

  select *
    into v_lot
  from public.live_sale_lots
  where id = _lot_id
    and status in ('open', 'reserved');

  if not found then
    raise exception 'Open live sale bag not found' using errcode = 'P0002';
  end if;

  select greatest(extract(epoch from (now() - s.started_at))::integer, 0)
    into v_elapsed
  from public.live_sale_sessions s
  where s.id = v_lot.session_id;

  insert into public.live_sale_manual_lot_items (
    lot_id,
    session_id,
    item_category,
    item_description,
    quantity,
    created_by,
    created_by_email,
    show_elapsed_seconds,
    notes
  )
  values (
    v_lot.id,
    v_lot.session_id,
    v_category,
    v_description,
    v_quantity,
    auth.uid(),
    nullif(btrim(coalesce(_signed_by_email, '')), ''),
    v_elapsed,
    nullif(btrim(coalesce(_notes, '')), '')
  )
  returning * into v_item;

  update public.live_sale_lots
  set status = 'reserved'
  where id = v_lot.id
    and status = 'open';

  insert into public.live_sale_events (
    session_id,
    lot_id,
    event_type,
    actor_email,
    notes,
    payload
  )
  values (
    v_lot.session_id,
    v_lot.id,
    'manual_item_added',
    nullif(btrim(coalesce(_signed_by_email, '')), ''),
    nullif(btrim(coalesce(_notes, '')), ''),
    jsonb_build_object(
      'manual_lot_item_id', v_item.id,
      'category', v_item.item_category,
      'description', v_item.item_description,
      'quantity', v_item.quantity
    )
  );

  return v_item;
end;
$$;

create or replace function public.set_live_sale_manual_lot_item_group_quantity(
  _lot_id uuid,
  _category text,
  _description text default null,
  _quantity integer default 1,
  _signed_by_email text default null,
  _notes text default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lot public.live_sale_lots;
  v_category text := nullif(btrim(coalesce(_category, '')), '');
  v_description text := nullif(btrim(coalesce(_description, '')), '');
  v_quantity integer := greatest(0, coalesce(_quantity, 0));
  v_existing integer := 0;
  v_delta integer := 0;
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to update manual live sale items' using errcode = '42501';
  end if;

  if _lot_id is null or v_category is null then
    raise exception 'Auction bag and category are required' using errcode = '22023';
  end if;

  select *
    into v_lot
  from public.live_sale_lots
  where id = _lot_id
    and status in ('open', 'reserved');

  if not found then
    raise exception 'Open live sale bag not found' using errcode = 'P0002';
  end if;

  select coalesce(sum(quantity), 0)::integer
    into v_existing
  from public.live_sale_manual_lot_items
  where lot_id = _lot_id
    and status = 'reserved'
    and lower(item_category) = lower(v_category)
    and coalesce(lower(item_description), '') = coalesce(lower(v_description), '');

  if v_quantity = 0 then
    update public.live_sale_manual_lot_items
    set status = 'released',
        notes = coalesce(notes || ' | ', '') || coalesce(nullif(btrim(coalesce(_notes, '')), ''), 'Released from current bag contents')
    where lot_id = _lot_id
      and status = 'reserved'
      and lower(item_category) = lower(v_category)
      and coalesce(lower(item_description), '') = coalesce(lower(v_description), '');
  elsif v_existing = 0 then
    perform public.add_live_sale_manual_lot_item(
      _lot_id,
      v_category,
      v_description,
      v_quantity,
      _signed_by_email,
      _notes
    );
  elsif v_quantity <> v_existing then
    v_delta := v_quantity - v_existing;
    if v_delta > 0 then
      perform public.add_live_sale_manual_lot_item(
        _lot_id,
        v_category,
        v_description,
        v_delta,
        _signed_by_email,
        _notes
      );
    else
      with reserved_rows as (
        select
          id,
          quantity,
          sum(quantity) over (order by created_at desc, id desc) as running_quantity
        from public.live_sale_manual_lot_items
        where lot_id = _lot_id
          and status = 'reserved'
          and lower(item_category) = lower(v_category)
          and coalesce(lower(item_description), '') = coalesce(lower(v_description), '')
        order by created_at desc, id desc
      )
      update public.live_sale_manual_lot_items item
      set quantity = case
            when rr.running_quantity <= abs(v_delta) then item.quantity
            else greatest(1, item.quantity - greatest(0, abs(v_delta) - (rr.running_quantity - rr.quantity)))
          end,
          status = case
            when rr.running_quantity <= abs(v_delta) then 'released'
            else item.status
          end,
          notes = coalesce(item.notes || ' | ', '') || coalesce(nullif(btrim(coalesce(_notes, '')), ''), 'Updated manual item quantity')
      from reserved_rows rr
      where item.id = rr.id
        and rr.running_quantity - rr.quantity < abs(v_delta);
    end if;
  end if;

  insert into public.live_sale_events (
    session_id,
    lot_id,
    event_type,
    actor_email,
    notes,
    payload
  )
  values (
    v_lot.session_id,
    v_lot.id,
    'manual_item_quantity_updated',
    nullif(btrim(coalesce(_signed_by_email, '')), ''),
    nullif(btrim(coalesce(_notes, '')), ''),
    jsonb_build_object(
      'category', v_category,
      'description', v_description,
      'old_quantity', v_existing,
      'new_quantity', v_quantity
    )
  );

  return v_quantity;
end;
$$;

-- Keep cancel behavior complete for bags containing manual/general items.
create or replace function public.cancel_live_sale_lot(
  _lot_id uuid,
  _notes text,
  _signed_by_email text default null
)
returns public.live_sale_lots
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lot public.live_sale_lots;
  v_note text := nullif(btrim(coalesce(_notes, '')), '');
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to cancel live sale lots' using errcode = '42501';
  end if;

  if v_note is null then
    raise exception 'A note is required to cancel a live sale bag' using errcode = '22023';
  end if;

  update public.live_sale_lot_items
  set status = 'cancelled',
      notes = coalesce(notes || ' | ', '') || v_note
  where lot_id = _lot_id
    and status = 'reserved';

  update public.live_sale_manual_lot_items
  set status = 'cancelled',
      notes = coalesce(notes || ' | ', '') || v_note
  where lot_id = _lot_id
    and status = 'reserved';

  update public.live_sale_lots
  set status = 'cancelled',
      closed_at = now(),
      notes = coalesce(notes || ' | ', '') || v_note
  where id = _lot_id
    and status in ('open', 'reserved')
  returning * into v_lot;

  if not found then
    raise exception 'Open live sale lot not found' using errcode = 'P0002';
  end if;

  insert into public.live_sale_events (
    session_id,
    lot_id,
    event_type,
    actor_email,
    notes
  )
  values (
    v_lot.session_id,
    v_lot.id,
    'lot_cancelled',
    nullif(btrim(coalesce(_signed_by_email, '')), ''),
    v_note
  );

  return v_lot;
end;
$$;

revoke all on function public.add_live_sale_manual_lot_item(uuid, text, text, integer, text, text) from public;
revoke all on function public.set_live_sale_manual_lot_item_group_quantity(uuid, text, text, integer, text, text) from public;
grant execute on function public.add_live_sale_manual_lot_item(uuid, text, text, integer, text, text) to authenticated;
grant execute on function public.set_live_sale_manual_lot_item_group_quantity(uuid, text, text, integer, text, text) to authenticated;

create or replace function public.cancel_manual_live_sale_items_for_cancelled_session()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'cancelled' and old.status is distinct from new.status then
    update public.live_sale_manual_lot_items
    set status = 'cancelled',
        notes = concat_ws(' | ', nullif(notes, ''), 'Session cancelled')
    where session_id = new.id
      and status = 'reserved';
  end if;

  return new;
end;
$$;

drop trigger if exists cancel_manual_live_sale_items_for_cancelled_session
  on public.live_sale_sessions;

create trigger cancel_manual_live_sale_items_for_cancelled_session
after update of status on public.live_sale_sessions
for each row
execute function public.cancel_manual_live_sale_items_for_cancelled_session();
