-- Track co-sellers on live sessions and per-bag ownership.

alter table public.live_sale_sessions
  add column if not exists primary_seller_employee_id uuid references public.employees(id) on delete set null,
  add column if not exists co_seller_employee_ids uuid[] not null default '{}'::uuid[],
  add column if not exists seller_snapshot jsonb not null default '{}'::jsonb;

alter table public.live_sale_lots
  add column if not exists owner_employee_id uuid references public.employees(id) on delete set null,
  add column if not exists owner_snapshot jsonb not null default '{}'::jsonb;

create index if not exists live_sale_sessions_primary_seller_idx
  on public.live_sale_sessions(primary_seller_employee_id);

create index if not exists live_sale_lots_owner_employee_idx
  on public.live_sale_lots(owner_employee_id);

create or replace function public.get_live_sale_seller_directory()
returns table (
  id uuid,
  display_name text,
  email text,
  role text
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    e.id,
    coalesce(nullif(btrim(e.display_name), ''), e.email, 'Unnamed seller') as display_name,
    e.email,
    e.role
  from public.employees e
  where e.active is distinct from false
    and public.can_manage_inventory()
  order by coalesce(nullif(btrim(e.display_name), ''), e.email, 'Unnamed seller'), e.email;
$$;

drop function if exists public.start_live_sale_session(text, uuid, text, text);

create or replace function public.start_live_sale_session(
  _title text default null,
  _store_id uuid default null,
  _notes text default null,
  _signed_by_email text default null,
  _primary_seller_employee_id uuid default null,
  _co_seller_employee_ids uuid[] default '{}'::uuid[]
)
returns public.live_sale_sessions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.live_sale_sessions;
  v_current_employee_id uuid;
  v_primary_seller_id uuid;
  v_co_seller_ids uuid[] := '{}'::uuid[];
  v_seller_snapshot jsonb := '{}'::jsonb;
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to start live sale sessions' using errcode = '42501';
  end if;

  if _store_id is not null and not exists (
    select 1 from public.store_locations where id = _store_id and active is true
  ) then
    raise exception 'Selected store is not active' using errcode = '22023';
  end if;

  select e.id
    into v_current_employee_id
  from public.employees e
  where e.user_id = auth.uid()
    and e.active is distinct from false
  limit 1;

  v_primary_seller_id := coalesce(_primary_seller_employee_id, v_current_employee_id);

  if v_primary_seller_id is null or not exists (
    select 1 from public.employees e
    where e.id = v_primary_seller_id
      and e.active is distinct from false
  ) then
    raise exception 'Select an active main seller for this live sale session' using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct e.id), '{}'::uuid[])
    into v_co_seller_ids
  from public.employees e
  where e.id = any(coalesce(_co_seller_employee_ids, '{}'::uuid[]))
    and e.id <> v_primary_seller_id
    and e.active is distinct from false;

  v_seller_snapshot := jsonb_build_object(
    'primary', (
      select jsonb_build_object(
        'id', e.id,
        'display_name', e.display_name,
        'email', e.email,
        'role', e.role
      )
      from public.employees e
      where e.id = v_primary_seller_id
    ),
    'co_sellers', (
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'id', e.id,
            'display_name', e.display_name,
            'email', e.email,
            'role', e.role
          )
          order by coalesce(nullif(btrim(e.display_name), ''), e.email)
        ),
        '[]'::jsonb
      )
      from public.employees e
      where e.id = any(v_co_seller_ids)
    )
  );

  insert into public.live_sale_sessions (
    title,
    store_id,
    started_by,
    started_by_email,
    notes,
    primary_seller_employee_id,
    co_seller_employee_ids,
    seller_snapshot
  )
  values (
    coalesce(nullif(btrim(_title), ''), 'Live Sale'),
    _store_id,
    auth.uid(),
    nullif(btrim(coalesce(_signed_by_email, '')), ''),
    nullif(btrim(coalesce(_notes, '')), ''),
    v_primary_seller_id,
    v_co_seller_ids,
    v_seller_snapshot
  )
  returning * into v_session;

  insert into public.live_sale_events (
    session_id,
    event_type,
    actor_email,
    notes,
    payload
  )
  values (
    v_session.id,
    'session_started',
    nullif(btrim(coalesce(_signed_by_email, '')), ''),
    nullif(btrim(coalesce(_notes, '')), ''),
    jsonb_build_object(
      'store_id', _store_id,
      'title', v_session.title,
      'primary_seller_employee_id', v_primary_seller_id,
      'co_seller_employee_ids', v_co_seller_ids,
      'seller_snapshot', v_seller_snapshot
    )
  );

  return v_session;
end;
$$;

drop function if exists public.create_live_sale_lot(uuid, text, text, text);

create or replace function public.create_live_sale_lot(
  _session_id uuid,
  _auction_number text,
  _notes text default null,
  _signed_by_email text default null,
  _owner_employee_id uuid default null
)
returns public.live_sale_lots
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.live_sale_sessions;
  v_lot public.live_sale_lots;
  v_auction text := nullif(btrim(coalesce(_auction_number, '')), '');
  v_current_employee_id uuid;
  v_owner_employee_id uuid;
  v_owner_snapshot jsonb := '{}'::jsonb;
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to create live sale lots' using errcode = '42501';
  end if;

  if v_auction is null then
    raise exception 'Auction number is required' using errcode = '22023';
  end if;

  select *
    into v_session
  from public.live_sale_sessions
  where id = _session_id
    and status = 'active';

  if not found then
    raise exception 'Active live sale session not found' using errcode = 'P0002';
  end if;

  select e.id
    into v_current_employee_id
  from public.employees e
  where e.user_id = auth.uid()
    and e.active is distinct from false
  limit 1;

  v_owner_employee_id := coalesce(_owner_employee_id, v_session.primary_seller_employee_id, v_current_employee_id);

  if v_owner_employee_id is not null and not exists (
    select 1 from public.employees e
    where e.id = v_owner_employee_id
      and e.active is distinct from false
  ) then
    raise exception 'Select an active owner for this auction bag' using errcode = '22023';
  end if;

  if v_owner_employee_id is not null then
    select jsonb_build_object(
      'id', e.id,
      'display_name', e.display_name,
      'email', e.email,
      'role', e.role
    )
      into v_owner_snapshot
    from public.employees e
    where e.id = v_owner_employee_id;
  end if;

  insert into public.live_sale_lots (
    session_id,
    auction_number,
    created_by,
    created_by_email,
    notes,
    owner_employee_id,
    owner_snapshot
  )
  values (
    v_session.id,
    v_auction,
    auth.uid(),
    nullif(btrim(coalesce(_signed_by_email, '')), ''),
    nullif(btrim(coalesce(_notes, '')), ''),
    v_owner_employee_id,
    coalesce(v_owner_snapshot, '{}'::jsonb)
  )
  on conflict (session_id, auction_number) do update
    set notes = coalesce(excluded.notes, public.live_sale_lots.notes),
        owner_employee_id = coalesce(excluded.owner_employee_id, public.live_sale_lots.owner_employee_id),
        owner_snapshot = case
          when excluded.owner_employee_id is not null then excluded.owner_snapshot
          else public.live_sale_lots.owner_snapshot
        end
  returning * into v_lot;

  insert into public.live_sale_events (
    session_id,
    lot_id,
    event_type,
    actor_email,
    notes,
    payload
  )
  values (
    v_session.id,
    v_lot.id,
    'lot_created',
    nullif(btrim(coalesce(_signed_by_email, '')), ''),
    nullif(btrim(coalesce(_notes, '')), ''),
    jsonb_build_object(
      'auction_number', v_lot.auction_number,
      'lot_code', v_lot.lot_code,
      'owner_employee_id', v_lot.owner_employee_id,
      'owner_snapshot', v_lot.owner_snapshot
    )
  );

  return v_lot;
end;
$$;

create or replace function public.update_live_sale_lot_owner(
  _lot_id uuid,
  _owner_employee_id uuid,
  _signed_by_email text default null
)
returns public.live_sale_lots
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old public.live_sale_lots;
  v_lot public.live_sale_lots;
  v_owner_snapshot jsonb := '{}'::jsonb;
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to update live sale bag owners' using errcode = '42501';
  end if;

  select *
    into v_old
  from public.live_sale_lots
  where id = _lot_id
    and status in ('open', 'reserved');

  if not found then
    raise exception 'Open live sale bag not found' using errcode = 'P0002';
  end if;

  if _owner_employee_id is null or not exists (
    select 1 from public.employees e
    where e.id = _owner_employee_id
      and e.active is distinct from false
  ) then
    raise exception 'Select an active owner for this auction bag' using errcode = '22023';
  end if;

  select jsonb_build_object(
    'id', e.id,
    'display_name', e.display_name,
    'email', e.email,
    'role', e.role
  )
    into v_owner_snapshot
  from public.employees e
  where e.id = _owner_employee_id;

  update public.live_sale_lots
  set owner_employee_id = _owner_employee_id,
      owner_snapshot = coalesce(v_owner_snapshot, '{}'::jsonb)
  where id = _lot_id
  returning * into v_lot;

  insert into public.live_sale_events (
    session_id,
    lot_id,
    event_type,
    actor_email,
    payload
  )
  values (
    v_lot.session_id,
    v_lot.id,
    'lot_owner_updated',
    nullif(btrim(coalesce(_signed_by_email, '')), ''),
    jsonb_build_object(
      'old_owner_employee_id', v_old.owner_employee_id,
      'new_owner_employee_id', v_lot.owner_employee_id,
      'old_owner_snapshot', v_old.owner_snapshot,
      'new_owner_snapshot', v_lot.owner_snapshot
    )
  );

  return v_lot;
end;
$$;

revoke all on function public.get_live_sale_seller_directory() from public;
revoke all on function public.start_live_sale_session(text, uuid, text, text, uuid, uuid[]) from public;
revoke all on function public.create_live_sale_lot(uuid, text, text, text, uuid) from public;
revoke all on function public.update_live_sale_lot_owner(uuid, uuid, text) from public;

grant execute on function public.get_live_sale_seller_directory() to authenticated;
grant execute on function public.start_live_sale_session(text, uuid, text, text, uuid, uuid[]) to authenticated;
grant execute on function public.create_live_sale_lot(uuid, text, text, text, uuid) to authenticated;
grant execute on function public.update_live_sale_lot_owner(uuid, uuid, text) to authenticated;
