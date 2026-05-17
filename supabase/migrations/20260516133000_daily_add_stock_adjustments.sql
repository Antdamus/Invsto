-- Admin corrections for stock check-ins shown on the Daily Adds page.

create table if not exists public.daily_stock_checkin_adjustments (
  id uuid primary key default gen_random_uuid(),
  source_transaction_id uuid not null references public.stock_transactions(id) on delete cascade,
  correction_transaction_id uuid references public.stock_transactions(id) on delete set null,
  item_id uuid references public.item_types(id) on delete set null,
  location_id uuid references public.locations(id) on delete set null,
  previous_quantity integer not null check (previous_quantity >= 0),
  new_quantity integer not null check (new_quantity >= 0),
  quantity_delta integer not null check (quantity_delta <> 0),
  reason text not null,
  performed_by uuid references auth.users(id) on delete set null,
  performed_by_email text,
  created_at timestamptz not null default now()
);

create index if not exists daily_stock_checkin_adjustments_source_idx
  on public.daily_stock_checkin_adjustments(source_transaction_id, created_at desc);

create index if not exists daily_stock_checkin_adjustments_created_idx
  on public.daily_stock_checkin_adjustments(created_at desc);

alter table public.daily_stock_checkin_adjustments enable row level security;

drop policy if exists "daily_stock_checkin_adjustments_admin_select" on public.daily_stock_checkin_adjustments;
create policy "daily_stock_checkin_adjustments_admin_select"
on public.daily_stock_checkin_adjustments
for select
to authenticated
using (public.is_admin());

grant select on table public.daily_stock_checkin_adjustments to authenticated;
grant select, insert, update, delete on table public.daily_stock_checkin_adjustments to service_role;

create or replace function public.admin_adjust_daily_stock_checkin(
  _source_transaction_id uuid,
  _new_quantity integer,
  _reason text,
  _admin_email text default null
)
returns public.daily_stock_checkin_adjustments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source public.stock_transactions%rowtype;
  v_current_quantity integer;
  v_new_quantity integer := coalesce(_new_quantity, -1);
  v_delta integer;
  v_reason text := nullif(btrim(coalesce(_reason, '')), '');
  v_admin_email text := nullif(btrim(coalesce(_admin_email, '')), '');
  v_now timestamptz := now();
  v_available integer;
  v_remaining integer;
  v_take integer;
  v_stock public.item_stock_locations%rowtype;
  v_correction_transaction_id uuid;
  v_adjustment public.daily_stock_checkin_adjustments;
begin
  if not public.is_admin() then
    raise exception 'Only admins can adjust daily stock check-ins' using errcode = '42501';
  end if;

  if _source_transaction_id is null then
    raise exception 'Source transaction is required' using errcode = '22023';
  end if;

  if v_new_quantity < 0 then
    raise exception 'New quantity must be zero or greater' using errcode = '22023';
  end if;

  if v_reason is null or length(v_reason) < 3 then
    raise exception 'A reason is required' using errcode = '22023';
  end if;

  select *
    into v_source
  from public.stock_transactions
  where id = _source_transaction_id
  for update;

  if not found then
    raise exception 'Source stock check-in was not found' using errcode = 'P0002';
  end if;

  if v_source.action_type <> 'checkin' or coalesce(v_source.quantity, 0) <= 0 then
    raise exception 'Only positive check-in transactions can be adjusted from Daily Adds' using errcode = '22023';
  end if;

  select coalesce(
    (
      select a.new_quantity
      from public.daily_stock_checkin_adjustments a
      where a.source_transaction_id = v_source.id
      order by a.created_at desc, a.id desc
      limit 1
    ),
    v_source.quantity
  )
  into v_current_quantity;

  v_delta := v_new_quantity - v_current_quantity;
  if v_delta = 0 then
    raise exception 'This check-in is already at that quantity' using errcode = '22023';
  end if;

  perform set_config('app.inventory_change_reason', 'Admin adjusted Daily Adds stock check-in: ' || v_reason, true);
  perform set_config('app.inventory_change_signed_by_email', coalesce(v_admin_email, ''), true);
  perform set_config('app.inventory_change_verified_method', 'admin_daily_add_adjustment', true);
  perform set_config('app.inventory_change_verified_at', v_now::text, true);

  if v_delta < 0 then
    v_remaining := abs(v_delta);

    select coalesce(sum(quantity), 0)
      into v_available
    from public.item_stock_locations
    where item_id = v_source.item_id
      and location_id = v_source.location_id
      and quantity > 0;

    if v_available < v_remaining then
      raise exception 'Only % unit(s) are currently available at this location; cannot remove % unit(s)', v_available, v_remaining using errcode = '22023';
    end if;

    for v_stock in
      select *
      from public.item_stock_locations
      where item_id = v_source.item_id
        and location_id = v_source.location_id
        and quantity > 0
      order by confirmed_at desc nulls last, last_updated desc nulls last, id
      for update
    loop
      v_take := least(v_stock.quantity, v_remaining);

      update public.item_stock_locations
      set quantity = quantity - v_take,
          last_updated = v_now,
          confirmation_email = coalesce(v_admin_email, confirmation_email),
          confirmation_method = 'admin_daily_add_adjustment',
          confirmed_at = v_now
      where id = v_stock.id;

      v_remaining := v_remaining - v_take;
      exit when v_remaining <= 0;
    end loop;
  else
    select *
      into v_stock
    from public.item_stock_locations
    where item_id = v_source.item_id
      and location_id = v_source.location_id
    order by (batch_id is null) desc, confirmed_at desc nulls last, last_updated desc nulls last, id
    limit 1
    for update;

    if found then
      update public.item_stock_locations
      set quantity = quantity + v_delta,
          last_updated = v_now,
          added_by = auth.uid(),
          confirmation_email = coalesce(v_admin_email, confirmation_email),
          confirmation_method = 'admin_daily_add_adjustment',
          confirmed_at = v_now
      where id = v_stock.id;
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
        v_source.item_id,
        v_source.location_id,
        v_delta,
        auth.uid(),
        v_admin_email,
        'admin_daily_add_adjustment',
        v_now,
        v_now
      );
    end if;
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
    source_transaction_id,
    method,
    timestamp
  )
  values (
    v_source.item_id,
    v_source.location_id,
    v_delta,
    'correction',
    v_now,
    auth.uid(),
    v_admin_email,
    case
      when v_new_quantity = 0 then 'Admin reverted Daily Adds inventory check-in'
      else 'Admin corrected Daily Adds inventory check-in from ' || v_current_quantity || ' to ' || v_new_quantity
    end || ' - ' || v_reason,
    v_source.id,
    'admin_daily_add_adjustment',
    v_now
  )
  returning id into v_correction_transaction_id;

  insert into public.daily_stock_checkin_adjustments (
    source_transaction_id,
    correction_transaction_id,
    item_id,
    location_id,
    previous_quantity,
    new_quantity,
    quantity_delta,
    reason,
    performed_by,
    performed_by_email,
    created_at
  )
  values (
    v_source.id,
    v_correction_transaction_id,
    v_source.item_id,
    v_source.location_id,
    v_current_quantity,
    v_new_quantity,
    v_delta,
    v_reason,
    auth.uid(),
    v_admin_email,
    v_now
  )
  returning * into v_adjustment;

  return v_adjustment;
end;
$$;

revoke all on function public.admin_adjust_daily_stock_checkin(uuid, integer, text, text) from public;
grant execute on function public.admin_adjust_daily_stock_checkin(uuid, integer, text, text) to authenticated;
