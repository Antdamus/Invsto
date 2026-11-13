-- Recover Show Studio: real month navigation, manager assignments, TikTok,
-- overnight shows, and serialized capacity checks. Existing rows are preserved.
begin;
alter table public.seller_sale_shifts drop constraint if exists seller_sale_shifts_channel_check;
alter table public.seller_sale_shifts add constraint seller_sale_shifts_channel_check check (channel in ('ebay','whatnot','tiktok'));
alter table public.seller_sale_blocked_times drop constraint if exists seller_sale_blocked_times_channel_check;
alter table public.seller_sale_blocked_times add constraint seller_sale_blocked_times_channel_check check (channel in ('all','ebay','whatnot','tiktok'));
alter table public.seller_shift_change_requests drop constraint if exists seller_shift_change_requests_requested_channel_check;
alter table public.seller_shift_change_requests add constraint seller_shift_change_requests_requested_channel_check check (requested_channel in ('ebay','whatnot','tiktok'));

create or replace function public.assert_seller_sale_shift_window(
  _start_at timestamptz,
  _end_at timestamptz,
  _timezone text default 'America/New_York'
)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz text := coalesce(nullif(_timezone, ''), 'America/New_York');
  v_start_local timestamp;
  v_end_local timestamp;
  v_month_start date := date_trunc('month', now() at time zone coalesce(nullif(_timezone, ''), 'America/New_York'))::date;
begin
  if _start_at is null or _end_at is null then
    raise exception 'Start and end time are required' using errcode = '22023';
  end if;

  if _end_at <= _start_at then
    raise exception 'End time must be after start time' using errcode = '22023';
  end if;

  if _end_at - _start_at < interval '2 hours' then
    raise exception 'Seller sale shifts must be at least 2 hours' using errcode = '22023';
  end if;

  v_start_local := _start_at at time zone v_tz;
  v_end_local := _end_at at time zone v_tz;

  if _end_at - _start_at > interval '24 hours' then
    raise exception 'Seller sale shifts must be at most 24 hours' using errcode = '22023';
  end if;

  if not public.current_user_can_manage_sellers() and date_trunc('month', v_start_local)::date <> v_month_start then
    raise exception 'Sellers can only book shifts in the current month' using errcode = '22023';
  end if;

  if extract(minute from v_start_local)::int not in (0, 30)
    or extract(minute from v_end_local)::int not in (0, 30)
    or date_trunc('minute', v_start_local) <> v_start_local
    or date_trunc('minute', v_end_local) <> v_end_local
  then
    raise exception 'Seller sale shifts must use 30-minute increments' using errcode = '22023';
  end if;
end;
$$;

create or replace function public.ensure_seller_sale_shift_available(
  _seller_employee_id uuid,
  _channel text,
  _store_id uuid,
  _start_at timestamptz,
  _end_at timestamptz,
  _exclude_shift_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_channel text := lower(nullif(btrim(coalesce(_channel, '')), ''));
  v_overlap_count integer;
begin
  -- Shared across all platforms so a seller cannot race two different channels.
  perform pg_advisory_xact_lock(hashtext('seller_schedule_capacity'));
  if v_channel not in ('ebay', 'whatnot', 'tiktok') then
    raise exception 'Choose eBay, Whatnot, or TikTok' using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.seller_sale_shifts s
    where s.seller_employee_id = _seller_employee_id
      and s.id is distinct from _exclude_shift_id
      and s.status = any (public.seller_sale_active_statuses())
      and s.start_at < _end_at
      and s.end_at > _start_at
  ) then
    raise exception 'This seller already has a shift during that time' using errcode = '23505';
  end if;

  if exists (
    select 1
    from public.seller_sale_blocked_times b
    where b.active is true
      and b.channel in ('all', v_channel)
      and b.start_at < _end_at
      and b.end_at > _start_at
  ) then
    raise exception 'Management has blocked that time' using errcode = '23505';
  end if;

  -- Peak simultaneous occupancy, not total shows touching a long window.
  with candidates as (
    select s.start_at, s.end_at from public.seller_sale_shifts s
    where s.channel = v_channel and s.id is distinct from _exclude_shift_id
      and s.status = any(public.seller_sale_active_statuses())
      and s.start_at < _end_at and s.end_at > _start_at
  ), points as (
    select _start_at as t union select greatest(start_at, _start_at) from candidates
  )
  select coalesce(max((select count(*) from candidates c where c.start_at <= p.t and c.end_at > p.t)),0)::integer
  into v_overlap_count from points p;

  if coalesce(v_overlap_count, 0) >= 2 then
    raise exception 'That % slot already has 2 sellers', v_channel using errcode = '23505';
  end if;
end;
$$;

create or replace function public.book_seller_sale_shift(
  _channel text,
  _store_id uuid,
  _start_at timestamptz,
  _end_at timestamptz,
  _notes text default null
)
returns public.seller_sale_shifts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_employee public.employees;
  v_store public.store_locations;
  v_channel text := lower(nullif(btrim(coalesce(_channel, '')), ''));
  v_shift public.seller_sale_shifts;
  v_title text;
  v_body text;
begin
  if not public.current_user_can_use_seller_schedule() then
    raise exception 'Not allowed to book seller shifts' using errcode = '42501';
  end if;

  select *
    into v_employee
  from public.employees
  where user_id = auth.uid()
    and active is distinct from false
  limit 1;

  if not found then
    raise exception 'Employee profile not found' using errcode = 'P0002';
  end if;

  if _store_id is not null then
    select *
      into v_store
    from public.store_locations
    where id = _store_id
      and active is true;
  else
    select *
      into v_store
    from public.store_locations
    where active is true
    order by created_at asc
    limit 1;
  end if;

  if not found then
    raise exception 'Select an active store for the seller shift' using errcode = '22023';
  end if;

  if v_channel not in ('ebay', 'whatnot', 'tiktok') then
    raise exception 'Choose eBay, Whatnot, or TikTok' using errcode = '22023';
  end if;

  perform public.assert_seller_sale_shift_window(_start_at, _end_at, v_store.timezone);
  perform pg_advisory_xact_lock(hashtext('seller_sale_shift:' || v_channel));
  perform public.ensure_seller_sale_shift_available(v_employee.id, v_channel, v_store.id, _start_at, _end_at, null);

  insert into public.seller_sale_shifts (
    seller_employee_id,
    seller_user_id,
    channel,
    store_id,
    start_at,
    end_at,
    notes,
    created_by,
    metadata
  )
  values (
    v_employee.id,
    v_employee.user_id,
    v_channel,
    v_store.id,
    _start_at,
    _end_at,
    nullif(btrim(coalesce(_notes, '')), ''),
    auth.uid(),
    jsonb_build_object(
      'commission_rate', 0.05,
      'commission_basis', 'net_store_proceeds_after_shipping_tax_platform_fees_returns',
      'payout_day', 'friday'
    )
  )
  returning * into v_shift;

  v_title := 'Seller shift booked';
  v_body := coalesce(v_employee.display_name, v_employee.email, 'Seller')
    || ' booked '
    || upper(v_channel)
    || ' '
    || to_char(_start_at at time zone v_store.timezone, 'Mon DD HH12:MI AM')
    || ' - '
    || to_char(_end_at at time zone v_store.timezone, 'HH12:MI AM')
    || '.';

  perform public.create_seller_notification(
    v_employee.id,
    'seller',
    'shift_booked',
    v_title,
    v_body,
    'normal',
    v_shift.id,
    null,
    jsonb_build_object('channel', v_channel, 'store_id', v_store.id)
  );

  perform public.notify_seller_management(
    v_employee.id,
    'shift_booked',
    v_title,
    v_body,
    'normal',
    v_shift.id,
    null,
    jsonb_build_object('channel', v_channel, 'store_id', v_store.id),
    false
  );

  return v_shift;
end;
$$;

create or replace function public.request_seller_sale_shift_edit(
  _shift_id uuid,
  _channel text,
  _store_id uuid,
  _start_at timestamptz,
  _end_at timestamptz,
  _reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_employee public.employees;
  v_shift public.seller_sale_shifts;
  v_store public.store_locations;
  v_channel text := lower(nullif(btrim(coalesce(_channel, '')), ''));
  v_requires_approval boolean;
  v_request public.seller_shift_change_requests;
  v_body text;
begin
  select *
    into v_employee
  from public.employees
  where user_id = auth.uid()
    and active is distinct from false
  limit 1;

  if not found then
    raise exception 'Employee profile not found' using errcode = 'P0002';
  end if;

  select *
    into v_shift
  from public.seller_sale_shifts
  where id = _shift_id
  for update;

  if not found then
    raise exception 'Seller shift not found' using errcode = 'P0002';
  end if;

  if v_shift.seller_employee_id <> v_employee.id and not public.current_user_can_manage_sellers() then
    raise exception 'Not allowed to edit this seller shift' using errcode = '42501';
  end if;

  if v_shift.status not in ('booked', 'edit_pending', 'cancel_pending') then
    raise exception 'Only booked seller shifts can be edited' using errcode = '22023';
  end if;

  select *
    into v_store
  from public.store_locations
  where id = coalesce(_store_id, v_shift.store_id)
    and active is true;

  if not found then
    raise exception 'Select an active store for the seller shift' using errcode = '22023';
  end if;

  if v_channel not in ('ebay', 'whatnot', 'tiktok') then
    raise exception 'Choose eBay, Whatnot, or TikTok' using errcode = '22023';
  end if;

  perform public.assert_seller_sale_shift_window(_start_at, _end_at, v_store.timezone);

  v_requires_approval := not public.current_user_can_manage_sellers()
    and v_shift.start_at < now() + interval '4 hours';

  if v_requires_approval then
    if exists (
      select 1
      from public.seller_shift_change_requests r
      where r.shift_id = v_shift.id
        and r.status = 'pending'
    ) then
      raise exception 'This shift already has a pending change request' using errcode = '23505';
    end if;

    insert into public.seller_shift_change_requests (
      shift_id,
      seller_employee_id,
      request_type,
      requested_channel,
      requested_store_id,
      requested_start_at,
      requested_end_at,
      reason
    )
    values (
      v_shift.id,
      v_shift.seller_employee_id,
      'edit',
      v_channel,
      v_store.id,
      _start_at,
      _end_at,
      nullif(btrim(coalesce(_reason, '')), '')
    )
    returning * into v_request;

    update public.seller_sale_shifts
    set status = 'edit_pending'
    where id = v_shift.id;

    v_body := coalesce(v_employee.display_name, v_employee.email, 'Seller')
      || ' requested a seller shift edit less than 4 hours before start.';

    perform public.notify_seller_management(
      v_shift.seller_employee_id,
      'shift_edit_requested',
      'Seller shift edit needs approval',
      v_body,
      'urgent',
      v_shift.id,
      v_request.id,
      jsonb_build_object('channel', v_channel, 'store_id', v_store.id),
      true
    );

    perform public.create_seller_notification(
      v_shift.seller_employee_id,
      'seller',
      'shift_edit_requested',
      'Shift edit sent for approval',
      'Management has been notified because this edit is less than 4 hours before the shift.',
      'normal',
      v_shift.id,
      v_request.id,
      '{}'::jsonb
    );

    return jsonb_build_object('status', 'approval_requested', 'shift_id', v_shift.id, 'request_id', v_request.id);
  end if;

  perform pg_advisory_xact_lock(hashtext('seller_sale_shift:' || v_channel));
  perform public.ensure_seller_sale_shift_available(v_shift.seller_employee_id, v_channel, v_store.id, _start_at, _end_at, v_shift.id);

  update public.seller_sale_shifts
  set channel = v_channel,
      store_id = v_store.id,
      start_at = _start_at,
      end_at = _end_at,
      status = 'booked',
      notes = nullif(btrim(coalesce(_reason, notes, '')), '')
  where id = v_shift.id
  returning * into v_shift;

  perform public.create_seller_notification(
    v_shift.seller_employee_id,
    'seller',
    'shift_edited',
    'Seller shift updated',
    'Your seller shift was updated.',
    'normal',
    v_shift.id,
    null,
    jsonb_build_object('channel', v_channel, 'store_id', v_store.id)
  );

  return jsonb_build_object('status', 'updated', 'shift_id', v_shift.id);
end;
$$;

create or replace function public.admin_save_seller_sale_block(
  _block_id uuid,
  _channel text,
  _start_at timestamptz,
  _end_at timestamptz,
  _reason text default null,
  _active boolean default true
)
returns public.seller_sale_blocked_times
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_channel text := lower(nullif(btrim(coalesce(_channel, 'all')), ''));
  v_block public.seller_sale_blocked_times;
begin
  if not public.current_user_can_manage_sellers() then
    raise exception 'Only management can block seller sale times' using errcode = '42501';
  end if;

  if v_channel not in ('all', 'ebay', 'whatnot', 'tiktok') then
    raise exception 'Invalid block channel' using errcode = '22023';
  end if;

  if _end_at <= _start_at then
    raise exception 'Block end time must be after start time' using errcode = '22023';
  end if;

  if _start_at is null or _end_at is null or _end_at <= _start_at then
    raise exception 'Choose a valid blocked time window' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('seller_schedule_capacity'));

  if _block_id is not null then
    update public.seller_sale_blocked_times
    set channel = v_channel,
        start_at = _start_at,
        end_at = _end_at,
        reason = nullif(btrim(coalesce(_reason, '')), ''),
        active = coalesce(_active, true)
    where id = _block_id
    returning * into v_block;
  end if;

  if v_block.id is null then
    insert into public.seller_sale_blocked_times (
      channel,
      start_at,
      end_at,
      reason,
      active,
      created_by
    )
    values (
      v_channel,
      _start_at,
      _end_at,
      nullif(btrim(coalesce(_reason, '')), ''),
      coalesce(_active, true),
      auth.uid()
    )
    returning * into v_block;
  end if;

  return v_block;
end;
$$;

create or replace function public.get_seller_schedule_month(_month date default null)
returns table (
  row_type text,
  shift_id uuid,
  block_id uuid,
  seller_employee_id uuid,
  seller_name text,
  seller_email text,
  channel text,
  store_id uuid,
  store_name text,
  start_at timestamptz,
  end_at timestamptz,
  status text,
  is_mine boolean,
  can_change_without_approval boolean,
  is_blocked boolean,
  notes text,
  metadata jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_month_start date := date_trunc('month', coalesce(_month, (now() at time zone 'America/New_York')::date))::date;
  v_month_end date := (v_month_start + interval '1 month')::date;
begin
  if not public.current_user_can_use_seller_schedule() then
    raise exception 'Not allowed to view seller schedule' using errcode = '42501';
  end if;

  return query
  select
    'shift'::text as row_type,
    s.id as shift_id,
    null::uuid as block_id,
    s.seller_employee_id,
    coalesce(nullif(btrim(e.display_name), ''), e.email, 'Unnamed seller') as seller_name,
    e.email as seller_email,
    s.channel,
    s.store_id,
    sl.name as store_name,
    s.start_at,
    s.end_at,
    s.status,
    e.user_id = auth.uid() as is_mine,
    s.start_at >= now() + interval '4 hours' or public.current_user_can_manage_sellers() as can_change_without_approval,
    false as is_blocked,
    s.notes,
    s.metadata
  from public.seller_sale_shifts s
  join public.employees e on e.id = s.seller_employee_id
  left join public.store_locations sl on sl.id = s.store_id
  where s.end_at > (v_month_start::timestamp at time zone 'America/New_York')
    and s.start_at < (v_month_end::timestamp at time zone 'America/New_York')
    and s.status <> 'cancelled'

  union all

  select
    'block'::text as row_type,
    null::uuid as shift_id,
    b.id as block_id,
    null::uuid as seller_employee_id,
    'Blocked'::text as seller_name,
    null::text as seller_email,
    b.channel,
    null::uuid as store_id,
    null::text as store_name,
    b.start_at,
    b.end_at,
    case when b.active then 'blocked' else 'inactive' end as status,
    false as is_mine,
    false as can_change_without_approval,
    true as is_blocked,
    b.reason as notes,
    jsonb_build_object('active', b.active) as metadata
  from public.seller_sale_blocked_times b
  where b.active is true
    and b.end_at > (v_month_start::timestamp at time zone 'America/New_York')
    and b.start_at < (v_month_end::timestamp at time zone 'America/New_York')
  order by 10, 1;
end;
$$;

-- Managers assign a show directly to an active team member; sellers keep
-- using the original self-booking and near-start approval workflows.
create or replace function public.admin_schedule_seller_show(
  _seller_employee_id uuid, _channel text, _store_id uuid,
  _start_at timestamptz, _end_at timestamptz, _notes text default null
)
returns public.seller_sale_shifts
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_employee public.employees;
  v_store public.store_locations;
  v_shift public.seller_sale_shifts;
  v_channel text := lower(btrim(coalesce(_channel,'')));
begin
  if not public.current_user_can_manage_sellers() then
    raise exception 'Only managers can assign shows to sellers' using errcode='42501';
  end if;
  select * into v_employee from public.employees
    where id=_seller_employee_id and active is distinct from false
      and lower(role) in ('seller','employee','manager','admin');
  if not found then raise exception 'Choose an active seller' using errcode='22023'; end if;
  select * into v_store from public.store_locations where id=_store_id and active is true;
  if not found then raise exception 'Choose an active store' using errcode='22023'; end if;
  perform public.assert_seller_sale_shift_window(_start_at,_end_at,v_store.timezone);
  perform public.ensure_seller_sale_shift_available(v_employee.id,v_channel,v_store.id,_start_at,_end_at,null);
  insert into public.seller_sale_shifts(seller_employee_id,seller_user_id,channel,store_id,start_at,end_at,notes,created_by,metadata)
    values(v_employee.id,v_employee.user_id,v_channel,v_store.id,_start_at,_end_at,nullif(btrim(_notes),''),auth.uid(),
      jsonb_build_object('scheduled_by_management',true,'commission_rate',0.05,
        'commission_basis','net_store_proceeds_after_shipping_tax_platform_fees_returns','payout_day','friday'))
    returning * into v_shift;
  perform public.create_seller_notification(v_employee.id,'seller','shift_booked','A show is on your calendar',
    upper(v_channel)||' · '||to_char(_start_at at time zone v_store.timezone,'Mon DD HH12:MI AM')||' · '||v_store.name,
    'normal',v_shift.id,null,jsonb_build_object('channel',v_channel,'store_id',v_store.id));
  return v_shift;
end;
$$;
revoke all on function public.admin_schedule_seller_show(uuid,text,uuid,timestamptz,timestamptz,text) from public,anon;
grant execute on function public.admin_schedule_seller_show(uuid,text,uuid,timestamptz,timestamptz,text) to authenticated;
commit;