-- Seller sale scheduling, commission-only operational shifts, and notifications.
-- Sellers can book eBay / Whatnot sale blocks for the current month while the
-- existing timeclock keeps attendance proof and exception alerts.

alter table public.employees
  drop constraint if exists employees_role_check;

alter table public.employees
  add constraint employees_role_check
  check (role = any (array['admin'::text, 'manager'::text, 'employee'::text, 'seller'::text]));

create or replace function public.current_employee_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select e.id
  from public.employees e
  where e.user_id = auth.uid()
    and e.active is distinct from false
  limit 1
$$;

create or replace function public.current_employee_role()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select lower(coalesce(e.role, ''))
  from public.employees e
  where e.user_id = auth.uid()
    and e.active is distinct from false
  limit 1
$$;

create or replace function public.current_user_can_manage_sellers()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.employees e
    where e.user_id = auth.uid()
      and e.active is distinct from false
      and lower(coalesce(e.role, '')) in ('admin', 'manager')
  )
$$;

create or replace function public.current_user_can_use_seller_schedule()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.employees e
    where e.user_id = auth.uid()
      and e.active is distinct from false
      and lower(coalesce(e.role, '')) in ('admin', 'manager', 'seller')
  )
$$;

create or replace function public.seller_sale_active_statuses()
returns text[]
language sql
immutable
as $$
  select array['booked', 'edit_pending', 'cancel_pending', 'checked_in', 'in_progress']::text[]
$$;

create table if not exists public.seller_sale_shifts (
  id uuid primary key default gen_random_uuid(),
  seller_employee_id uuid not null references public.employees(id) on delete cascade,
  seller_user_id uuid references auth.users(id) on delete set null,
  channel text not null check (channel in ('ebay', 'whatnot')),
  store_id uuid not null references public.store_locations(id),
  start_at timestamptz not null,
  end_at timestamptz not null,
  status text not null default 'booked'
    check (status in (
      'booked',
      'edit_pending',
      'cancel_pending',
      'checked_in',
      'in_progress',
      'completed',
      'cancelled',
      'no_show'
    )),
  commission_only boolean not null default true,
  commission_rate numeric(6,5) not null default 0.05 check (commission_rate = 0.05),
  notes text,
  cancel_reason text,
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  constraint seller_sale_shifts_time_order check (end_at > start_at),
  constraint seller_sale_shifts_min_duration check (end_at >= start_at + interval '2 hours')
);

create index if not exists seller_sale_shifts_month_idx
  on public.seller_sale_shifts(start_at, end_at);

create index if not exists seller_sale_shifts_channel_time_idx
  on public.seller_sale_shifts(channel, start_at, end_at)
  where status = any (array['booked', 'edit_pending', 'cancel_pending', 'checked_in', 'in_progress']);

create index if not exists seller_sale_shifts_employee_time_idx
  on public.seller_sale_shifts(seller_employee_id, start_at, end_at);

create table if not exists public.seller_sale_blocked_times (
  id uuid primary key default gen_random_uuid(),
  channel text not null default 'all' check (channel in ('all', 'ebay', 'whatnot')),
  start_at timestamptz not null,
  end_at timestamptz not null,
  reason text,
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint seller_sale_blocked_times_order check (end_at > start_at)
);

create index if not exists seller_sale_blocked_times_active_idx
  on public.seller_sale_blocked_times(channel, start_at, end_at)
  where active is true;

create table if not exists public.seller_shift_change_requests (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null references public.seller_sale_shifts(id) on delete cascade,
  seller_employee_id uuid not null references public.employees(id) on delete cascade,
  request_type text not null check (request_type in ('edit', 'cancel')),
  requested_channel text check (requested_channel in ('ebay', 'whatnot')),
  requested_store_id uuid references public.store_locations(id),
  requested_start_at timestamptz,
  requested_end_at timestamptz,
  reason text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'denied', 'cancelled')),
  requested_by uuid references auth.users(id) on delete set null default auth.uid(),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists seller_shift_change_requests_status_idx
  on public.seller_shift_change_requests(status, created_at desc);

create index if not exists seller_shift_change_requests_shift_idx
  on public.seller_shift_change_requests(shift_id, status);

create table if not exists public.seller_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_employee_id uuid references public.employees(id) on delete cascade,
  recipient_user_id uuid references auth.users(id) on delete cascade,
  recipient_email text,
  audience text not null default 'seller' check (audience in ('seller', 'management')),
  notification_type text not null,
  title text not null,
  body text not null default '',
  urgency text not null default 'normal' check (urgency in ('normal', 'urgent')),
  shift_id uuid references public.seller_sale_shifts(id) on delete cascade,
  request_id uuid references public.seller_shift_change_requests(id) on delete cascade,
  commission_ledger_id uuid,
  return_case_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists seller_notifications_recipient_idx
  on public.seller_notifications(recipient_user_id, created_at desc);

create index if not exists seller_notifications_unread_idx
  on public.seller_notifications(recipient_user_id, created_at desc)
  where read_at is null;

create table if not exists public.seller_commission_ledger (
  id uuid primary key default gen_random_uuid(),
  seller_employee_id uuid not null references public.employees(id) on delete restrict,
  shift_id uuid references public.seller_sale_shifts(id) on delete set null,
  channel text not null check (channel in ('ebay', 'whatnot')),
  sale_id uuid references public.sales(id) on delete set null,
  sale_item_id uuid references public.sale_items(id) on delete set null,
  ebay_order_line_id uuid references public.ebay_order_lines(id) on delete set null,
  source_type text not null default 'sale'
    check (source_type in ('sale', 'return', 'cancellation', 'adjustment', 'payout')),
  source_id text,
  source_label text,
  gross_amount numeric(12,2) not null default 0,
  shipping_amount numeric(12,2) not null default 0,
  tax_amount numeric(12,2) not null default 0,
  platform_fee_amount numeric(12,2) not null default 0,
  other_fee_amount numeric(12,2) not null default 0,
  refund_amount numeric(12,2) not null default 0,
  net_store_proceeds numeric(12,2) not null default 0,
  commission_rate numeric(6,5) not null default 0.05 check (commission_rate = 0.05),
  commission_amount numeric(12,2) not null default 0,
  status text not null default 'pending'
    check (status in ('pending', 'earned', 'payable', 'paid', 'reversed', 'deducted', 'void')),
  payout_id uuid,
  return_case_id uuid,
  return_proof_url text,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists seller_commission_ledger_seller_idx
  on public.seller_commission_ledger(seller_employee_id, created_at desc);

create index if not exists seller_commission_ledger_payout_idx
  on public.seller_commission_ledger(payout_id);

create table if not exists public.seller_commission_payouts (
  id uuid primary key default gen_random_uuid(),
  seller_employee_id uuid not null references public.employees(id) on delete restrict,
  period_start date not null,
  period_end date not null,
  payout_date date not null,
  gross_commission numeric(12,2) not null default 0,
  deductions numeric(12,2) not null default 0,
  net_commission numeric(12,2) not null default 0,
  status text not null default 'draft' check (status in ('draft', 'approved', 'paid', 'void')),
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  paid_by uuid references auth.users(id) on delete set null,
  paid_at timestamptz,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint seller_commission_payouts_dates check (period_end >= period_start)
);

alter table public.seller_commission_ledger
  drop constraint if exists seller_commission_ledger_payout_id_fkey;

alter table public.seller_commission_ledger
  add constraint seller_commission_ledger_payout_id_fkey
  foreign key (payout_id) references public.seller_commission_payouts(id) on delete set null;

alter table public.sale_items
  add column if not exists seller_employee_id uuid references public.employees(id) on delete set null,
  add column if not exists seller_sale_shift_id uuid references public.seller_sale_shifts(id) on delete set null,
  add column if not exists seller_snapshot jsonb not null default '{}'::jsonb;

alter table public.sales
  add column if not exists seller_employee_id uuid references public.employees(id) on delete set null,
  add column if not exists seller_sale_shift_id uuid references public.seller_sale_shifts(id) on delete set null,
  add column if not exists seller_snapshot jsonb not null default '{}'::jsonb;

alter table public.ebay_order_lines
  add column if not exists assigned_seller_employee_id uuid references public.employees(id) on delete set null,
  add column if not exists assigned_seller_snapshot jsonb not null default '{}'::jsonb;

create or replace function public.seller_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_seller_sale_shifts_updated_at on public.seller_sale_shifts;
create trigger trg_seller_sale_shifts_updated_at
before update on public.seller_sale_shifts
for each row execute function public.seller_touch_updated_at();

drop trigger if exists trg_seller_sale_blocked_times_updated_at on public.seller_sale_blocked_times;
create trigger trg_seller_sale_blocked_times_updated_at
before update on public.seller_sale_blocked_times
for each row execute function public.seller_touch_updated_at();

drop trigger if exists trg_seller_shift_change_requests_updated_at on public.seller_shift_change_requests;
create trigger trg_seller_shift_change_requests_updated_at
before update on public.seller_shift_change_requests
for each row execute function public.seller_touch_updated_at();

drop trigger if exists trg_seller_commission_ledger_updated_at on public.seller_commission_ledger;
create trigger trg_seller_commission_ledger_updated_at
before update on public.seller_commission_ledger
for each row execute function public.seller_touch_updated_at();

drop trigger if exists trg_seller_commission_payouts_updated_at on public.seller_commission_payouts;
create trigger trg_seller_commission_payouts_updated_at
before update on public.seller_commission_payouts
for each row execute function public.seller_touch_updated_at();

create or replace function public.set_seller_commission_amount()
returns trigger
language plpgsql
as $$
begin
  new.commission_amount := round(coalesce(new.net_store_proceeds, 0) * coalesce(new.commission_rate, 0.05), 2);
  return new;
end;
$$;

drop trigger if exists trg_seller_commission_amount on public.seller_commission_ledger;
create trigger trg_seller_commission_amount
before insert or update of net_store_proceeds, commission_rate
on public.seller_commission_ledger
for each row execute function public.set_seller_commission_amount();

alter table public.seller_sale_shifts enable row level security;
alter table public.seller_sale_blocked_times enable row level security;
alter table public.seller_shift_change_requests enable row level security;
alter table public.seller_notifications enable row level security;
alter table public.seller_commission_ledger enable row level security;
alter table public.seller_commission_payouts enable row level security;

drop policy if exists "seller_sale_shifts_visible_to_schedule_users" on public.seller_sale_shifts;
create policy "seller_sale_shifts_visible_to_schedule_users"
on public.seller_sale_shifts
for select
to authenticated
using (public.current_user_can_use_seller_schedule());

drop policy if exists "seller_sale_shifts_management_write" on public.seller_sale_shifts;
create policy "seller_sale_shifts_management_write"
on public.seller_sale_shifts
for all
to authenticated
using (public.current_user_can_manage_sellers())
with check (public.current_user_can_manage_sellers());

drop policy if exists "seller_sale_blocked_times_visible_to_schedule_users" on public.seller_sale_blocked_times;
create policy "seller_sale_blocked_times_visible_to_schedule_users"
on public.seller_sale_blocked_times
for select
to authenticated
using (public.current_user_can_use_seller_schedule());

drop policy if exists "seller_sale_blocked_times_management_write" on public.seller_sale_blocked_times;
create policy "seller_sale_blocked_times_management_write"
on public.seller_sale_blocked_times
for all
to authenticated
using (public.current_user_can_manage_sellers())
with check (public.current_user_can_manage_sellers());

drop policy if exists "seller_shift_change_requests_visible" on public.seller_shift_change_requests;
create policy "seller_shift_change_requests_visible"
on public.seller_shift_change_requests
for select
to authenticated
using (
  public.current_user_can_manage_sellers()
  or exists (
    select 1
    from public.employees e
    where e.id = seller_shift_change_requests.seller_employee_id
      and e.user_id = auth.uid()
  )
);

drop policy if exists "seller_shift_change_requests_management_write" on public.seller_shift_change_requests;
create policy "seller_shift_change_requests_management_write"
on public.seller_shift_change_requests
for all
to authenticated
using (public.current_user_can_manage_sellers())
with check (public.current_user_can_manage_sellers());

drop policy if exists "seller_notifications_visible" on public.seller_notifications;
create policy "seller_notifications_visible"
on public.seller_notifications
for select
to authenticated
using (recipient_user_id = auth.uid() or public.current_user_can_manage_sellers());

drop policy if exists "seller_notifications_mark_read" on public.seller_notifications;
create policy "seller_notifications_mark_read"
on public.seller_notifications
for update
to authenticated
using (recipient_user_id = auth.uid() or public.current_user_can_manage_sellers())
with check (recipient_user_id = auth.uid() or public.current_user_can_manage_sellers());

drop policy if exists "seller_commission_ledger_visible" on public.seller_commission_ledger;
create policy "seller_commission_ledger_visible"
on public.seller_commission_ledger
for select
to authenticated
using (
  public.current_user_can_manage_sellers()
  or exists (
    select 1
    from public.employees e
    where e.id = seller_commission_ledger.seller_employee_id
      and e.user_id = auth.uid()
  )
);

drop policy if exists "seller_commission_ledger_management_write" on public.seller_commission_ledger;
create policy "seller_commission_ledger_management_write"
on public.seller_commission_ledger
for all
to authenticated
using (public.current_user_can_manage_sellers())
with check (public.current_user_can_manage_sellers());

drop policy if exists "seller_commission_payouts_visible" on public.seller_commission_payouts;
create policy "seller_commission_payouts_visible"
on public.seller_commission_payouts
for select
to authenticated
using (
  public.current_user_can_manage_sellers()
  or exists (
    select 1
    from public.employees e
    where e.id = seller_commission_payouts.seller_employee_id
      and e.user_id = auth.uid()
  )
);

drop policy if exists "seller_commission_payouts_management_write" on public.seller_commission_payouts;
create policy "seller_commission_payouts_management_write"
on public.seller_commission_payouts
for all
to authenticated
using (public.current_user_can_manage_sellers())
with check (public.current_user_can_manage_sellers());

grant select on public.seller_sale_shifts to authenticated;
grant select on public.seller_sale_blocked_times to authenticated;
grant select on public.seller_shift_change_requests to authenticated;
grant select, update on public.seller_notifications to authenticated;
grant select on public.seller_commission_ledger to authenticated;
grant select on public.seller_commission_payouts to authenticated;
grant select, insert, update, delete on public.seller_sale_shifts to service_role;
grant select, insert, update, delete on public.seller_sale_blocked_times to service_role;
grant select, insert, update, delete on public.seller_shift_change_requests to service_role;
grant select, insert, update, delete on public.seller_notifications to service_role;
grant select, insert, update, delete on public.seller_commission_ledger to service_role;
grant select, insert, update, delete on public.seller_commission_payouts to service_role;

create or replace function public.create_seller_notification(
  _recipient_employee_id uuid,
  _audience text,
  _notification_type text,
  _title text,
  _body text default '',
  _urgency text default 'normal',
  _shift_id uuid default null,
  _request_id uuid default null,
  _metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_employee public.employees;
  v_id uuid;
begin
  if _recipient_employee_id is null then
    return null;
  end if;

  select *
    into v_employee
  from public.employees
  where id = _recipient_employee_id
    and active is distinct from false;

  if not found or v_employee.user_id is null then
    return null;
  end if;

  insert into public.seller_notifications (
    recipient_employee_id,
    recipient_user_id,
    recipient_email,
    audience,
    notification_type,
    title,
    body,
    urgency,
    shift_id,
    request_id,
    metadata
  )
  values (
    v_employee.id,
    v_employee.user_id,
    v_employee.email,
    case when _audience = 'management' then 'management' else 'seller' end,
    nullif(btrim(coalesce(_notification_type, '')), ''),
    nullif(btrim(coalesce(_title, '')), ''),
    coalesce(_body, ''),
    case when _urgency = 'urgent' then 'urgent' else 'normal' end,
    _shift_id,
    _request_id,
    coalesce(_metadata, '{}'::jsonb)
  )
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.enqueue_seller_manager_sms(
  _seller_employee_id uuid,
  _body text,
  _meta jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  p record;
begin
  for p in select phone_e164 from public.get_alert_recipient_phones(_seller_employee_id)
  loop
    insert into public.sms_outbox(to_phone, body, status, meta)
    values (
      p.phone_e164,
      left(coalesce(_body, ''), 480),
      'pending',
      coalesce(_meta, '{}'::jsonb)
    );
  end loop;
end;
$$;

create or replace function public.notify_seller_management(
  _seller_employee_id uuid,
  _notification_type text,
  _title text,
  _body text,
  _urgency text default 'normal',
  _shift_id uuid default null,
  _request_id uuid default null,
  _metadata jsonb default '{}'::jsonb,
  _send_sms boolean default false
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  manager_row record;
begin
  for manager_row in
    select e.id
    from public.employees e
    where e.active is distinct from false
      and e.user_id is not null
      and lower(coalesce(e.role, '')) in ('admin', 'manager')
  loop
    perform public.create_seller_notification(
      manager_row.id,
      'management',
      _notification_type,
      _title,
      _body,
      _urgency,
      _shift_id,
      _request_id,
      _metadata
    );
  end loop;

  if _send_sms is true then
    perform public.enqueue_seller_manager_sms(
      _seller_employee_id,
      _body,
      coalesce(_metadata, '{}'::jsonb) || jsonb_build_object(
        'type', 'seller_notification',
        'notification_type', _notification_type,
        'shift_id', _shift_id,
        'request_id', _request_id
      )
    );
  end if;
end;
$$;

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

  if v_start_local::date <> v_end_local::date then
    raise exception 'Seller sale shifts must stay within one local day' using errcode = '22023';
  end if;

  if date_trunc('month', v_start_local)::date <> v_month_start then
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
  if v_channel not in ('ebay', 'whatnot') then
    raise exception 'Choose eBay or Whatnot' using errcode = '22023';
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

  select count(*)::integer
    into v_overlap_count
  from public.seller_sale_shifts s
  where s.channel = v_channel
    and s.id is distinct from _exclude_shift_id
    and s.status = any (public.seller_sale_active_statuses())
    and s.start_at < _end_at
    and s.end_at > _start_at;

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

  if v_channel not in ('ebay', 'whatnot') then
    raise exception 'Choose eBay or Whatnot' using errcode = '22023';
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

  if v_channel not in ('ebay', 'whatnot') then
    raise exception 'Choose eBay or Whatnot' using errcode = '22023';
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

create or replace function public.cancel_seller_sale_shift(
  _shift_id uuid,
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
    raise exception 'Not allowed to cancel this seller shift' using errcode = '42501';
  end if;

  if v_shift.status not in ('booked', 'edit_pending', 'cancel_pending') then
    raise exception 'Only booked seller shifts can be cancelled' using errcode = '22023';
  end if;

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
      reason
    )
    values (
      v_shift.id,
      v_shift.seller_employee_id,
      'cancel',
      nullif(btrim(coalesce(_reason, '')), '')
    )
    returning * into v_request;

    update public.seller_sale_shifts
    set status = 'cancel_pending'
    where id = v_shift.id;

    v_body := coalesce(v_employee.display_name, v_employee.email, 'Seller')
      || ' requested a seller shift cancellation less than 4 hours before start.';

    perform public.notify_seller_management(
      v_shift.seller_employee_id,
      'shift_cancel_requested',
      'Seller shift cancellation needs approval',
      v_body,
      'urgent',
      v_shift.id,
      v_request.id,
      jsonb_build_object('channel', v_shift.channel, 'reason', _reason),
      true
    );

    perform public.create_seller_notification(
      v_shift.seller_employee_id,
      'seller',
      'shift_cancel_requested',
      'Cancellation sent for approval',
      'Management has been notified because this cancellation is less than 4 hours before the shift.',
      'normal',
      v_shift.id,
      v_request.id,
      '{}'::jsonb
    );

    return jsonb_build_object('status', 'approval_requested', 'shift_id', v_shift.id, 'request_id', v_request.id);
  end if;

  update public.seller_sale_shifts
  set status = 'cancelled',
      cancel_reason = nullif(btrim(coalesce(_reason, '')), ''),
      cancelled_at = now(),
      cancelled_by = auth.uid()
  where id = v_shift.id;

  perform public.create_seller_notification(
    v_shift.seller_employee_id,
    'seller',
    'shift_cancelled',
    'Seller shift cancelled',
    'Your seller shift was cancelled.',
    'normal',
    v_shift.id,
    null,
    jsonb_build_object('channel', v_shift.channel)
  );

  return jsonb_build_object('status', 'cancelled', 'shift_id', v_shift.id);
end;
$$;

create or replace function public.admin_review_seller_shift_request(
  _request_id uuid,
  _decision text,
  _review_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.seller_shift_change_requests;
  v_shift public.seller_sale_shifts;
  v_store public.store_locations;
  v_decision text := lower(nullif(btrim(coalesce(_decision, '')), ''));
begin
  if not public.current_user_can_manage_sellers() then
    raise exception 'Only management can review seller shift requests' using errcode = '42501';
  end if;

  if v_decision not in ('approve', 'deny') then
    raise exception 'Decision must be approve or deny' using errcode = '22023';
  end if;

  select *
    into v_request
  from public.seller_shift_change_requests
  where id = _request_id
  for update;

  if not found or v_request.status <> 'pending' then
    raise exception 'Pending seller shift request not found' using errcode = 'P0002';
  end if;

  select *
    into v_shift
  from public.seller_sale_shifts
  where id = v_request.shift_id
  for update;

  if not found then
    raise exception 'Seller shift not found' using errcode = 'P0002';
  end if;

  if v_decision = 'deny' then
    update public.seller_shift_change_requests
    set status = 'denied',
        reviewed_by = auth.uid(),
        reviewed_at = now(),
        review_note = nullif(btrim(coalesce(_review_note, '')), '')
    where id = v_request.id;

    update public.seller_sale_shifts
    set status = 'booked'
    where id = v_shift.id
      and status in ('edit_pending', 'cancel_pending');

    perform public.create_seller_notification(
      v_shift.seller_employee_id,
      'seller',
      'shift_request_denied',
      'Shift request denied',
      coalesce(nullif(btrim(_review_note), ''), 'Management denied the requested seller shift change.'),
      'normal',
      v_shift.id,
      v_request.id,
      '{}'::jsonb
    );

    return jsonb_build_object('status', 'denied', 'request_id', v_request.id, 'shift_id', v_shift.id);
  end if;

  if v_request.request_type = 'cancel' then
    update public.seller_sale_shifts
    set status = 'cancelled',
        cancel_reason = v_request.reason,
        cancelled_at = now(),
        cancelled_by = auth.uid()
    where id = v_shift.id;
  else
    select *
      into v_store
    from public.store_locations
    where id = coalesce(v_request.requested_store_id, v_shift.store_id)
      and active is true;

    if not found then
      raise exception 'Requested store is no longer active' using errcode = '22023';
    end if;

    perform public.assert_seller_sale_shift_window(v_request.requested_start_at, v_request.requested_end_at, v_store.timezone);
    perform pg_advisory_xact_lock(hashtext('seller_sale_shift:' || v_request.requested_channel));
    perform public.ensure_seller_sale_shift_available(
      v_shift.seller_employee_id,
      v_request.requested_channel,
      v_store.id,
      v_request.requested_start_at,
      v_request.requested_end_at,
      v_shift.id
    );

    update public.seller_sale_shifts
    set channel = v_request.requested_channel,
        store_id = v_store.id,
        start_at = v_request.requested_start_at,
        end_at = v_request.requested_end_at,
        status = 'booked',
        notes = coalesce(v_request.reason, notes)
    where id = v_shift.id;
  end if;

  update public.seller_shift_change_requests
  set status = 'approved',
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      review_note = nullif(btrim(coalesce(_review_note, '')), '')
  where id = v_request.id;

  perform public.create_seller_notification(
    v_shift.seller_employee_id,
    'seller',
    'shift_request_approved',
    'Shift request approved',
    coalesce(nullif(btrim(_review_note), ''), 'Management approved the requested seller shift change.'),
    'normal',
    v_shift.id,
    v_request.id,
    '{}'::jsonb
  );

  return jsonb_build_object('status', 'approved', 'request_id', v_request.id, 'shift_id', v_shift.id);
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

  if v_channel not in ('all', 'ebay', 'whatnot') then
    raise exception 'Invalid block channel' using errcode = '22023';
  end if;

  if _end_at <= _start_at then
    raise exception 'Block end time must be after start time' using errcode = '22023';
  end if;

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
  v_month_start date := date_trunc('month', now() at time zone 'America/New_York')::date;
  v_month_end date := (date_trunc('month', now() at time zone 'America/New_York') + interval '1 month')::date;
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
  where (s.start_at at time zone coalesce(sl.timezone, 'America/New_York'))::date >= v_month_start
    and (s.start_at at time zone coalesce(sl.timezone, 'America/New_York'))::date < v_month_end
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
    and (b.start_at at time zone 'America/New_York')::date >= v_month_start
    and (b.start_at at time zone 'America/New_York')::date < v_month_end
  order by 10, 1;
end;
$$;

create or replace view public.effective_work_shifts as
with override_days as (
  select distinct employee_id, work_date
  from public.work_schedule_overrides
),
override_shifts as (
  select
    o.employee_id,
    o.work_date,
    o.start_local,
    o.end_local,
    o.store_id,
    'override'::text as source
  from public.work_schedule_overrides o
  where o.off = false
),
regular_shifts as (
  select
    ws.employee_id,
    d.work_date,
    ws.start_local,
    ws.end_local,
    ws.store_id,
    'regular'::text as source
  from public.work_schedules ws
  join lateral (
    select generate_series(
      ws.effective_from,
      coalesce(ws.effective_to, ws.effective_from + interval '2 years'),
      interval '1 day'
    )::date as work_date
  ) d on true
  where ws.active = true
    and extract(dow from d.work_date) = ws.weekday
    and not exists (
      select 1
      from override_days od
      where od.employee_id = ws.employee_id
        and od.work_date = d.work_date
    )
),
seller_shifts as (
  select
    s.seller_employee_id as employee_id,
    (s.start_at at time zone coalesce(sl.timezone, 'America/New_York'))::date as work_date,
    (s.start_at at time zone coalesce(sl.timezone, 'America/New_York'))::time as start_local,
    (s.end_at at time zone coalesce(sl.timezone, 'America/New_York'))::time as end_local,
    s.store_id,
    'seller_sale'::text as source
  from public.seller_sale_shifts s
  left join public.store_locations sl on sl.id = s.store_id
  where s.status = any (public.seller_sale_active_statuses())
)
select * from override_shifts
union all
select * from regular_shifts
union all
select * from seller_shifts;

create or replace function public.get_employee_schedule(_employee_id uuid, _start date, _end date)
returns table(work_date date, start_ts timestamptz, end_ts timestamptz, source text, store_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    ews.work_date,
    ((ews.work_date::timestamp + ews.start_local) at time zone coalesce(sl.timezone, 'America/New_York')) as start_ts,
    case
      when ((ews.work_date::timestamp + ews.end_local) at time zone coalesce(sl.timezone, 'America/New_York'))
        <= ((ews.work_date::timestamp + ews.start_local) at time zone coalesce(sl.timezone, 'America/New_York'))
      then ((ews.work_date::timestamp + ews.end_local) at time zone coalesce(sl.timezone, 'America/New_York')) + interval '24 hours'
      else ((ews.work_date::timestamp + ews.end_local) at time zone coalesce(sl.timezone, 'America/New_York'))
    end as end_ts,
    ews.source,
    ews.store_id
  from public.effective_work_shifts ews
  left join public.store_locations sl on sl.id = ews.store_id
  where ews.employee_id = _employee_id
    and ews.work_date between _start and _end
    and ews.start_local is not null
    and ews.end_local is not null
  order by ews.work_date, start_ts
$$;

create or replace function public.get_schedule_range_all(_start date, _end date)
returns table(work_date date, employee_id uuid, display_name text, start_ts timestamptz, end_ts timestamptz, source text, store_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    ews.work_date,
    ews.employee_id,
    e.display_name,
    ((ews.work_date::timestamp + ews.start_local) at time zone coalesce(sl.timezone, 'America/New_York')) as start_ts,
    case
      when ((ews.work_date::timestamp + ews.end_local) at time zone coalesce(sl.timezone, 'America/New_York'))
        <= ((ews.work_date::timestamp + ews.start_local) at time zone coalesce(sl.timezone, 'America/New_York'))
      then ((ews.work_date::timestamp + ews.end_local) at time zone coalesce(sl.timezone, 'America/New_York')) + interval '24 hours'
      else ((ews.work_date::timestamp + ews.end_local) at time zone coalesce(sl.timezone, 'America/New_York'))
    end as end_ts,
    ews.source,
    ews.store_id
  from public.effective_work_shifts ews
  join public.employees e on e.id = ews.employee_id and e.active is true
  left join public.store_locations sl on sl.id = ews.store_id
  where ews.work_date between _start and _end
    and ews.start_local is not null
    and ews.end_local is not null
    and public.is_admin()
  order by ews.work_date, e.display_name, start_ts
$$;

create or replace function public.resolve_expected_window(_employee_id uuid, _ts timestamptz, _store_id uuid default null)
returns table(expected_start_ts timestamptz, expected_end_ts timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with candidates as (
    select
      ews.employee_id,
      ews.work_date,
      ews.start_local,
      ews.end_local,
      ews.store_id,
      coalesce(sl.timezone, 'America/New_York') as timezone,
      ((ews.work_date::timestamp + ews.start_local) at time zone coalesce(sl.timezone, 'America/New_York')) as shift_start_ts,
      case
        when ((ews.work_date::timestamp + ews.end_local) at time zone coalesce(sl.timezone, 'America/New_York'))
          <= ((ews.work_date::timestamp + ews.start_local) at time zone coalesce(sl.timezone, 'America/New_York'))
        then ((ews.work_date::timestamp + ews.end_local) at time zone coalesce(sl.timezone, 'America/New_York')) + interval '24 hours'
        else ((ews.work_date::timestamp + ews.end_local) at time zone coalesce(sl.timezone, 'America/New_York'))
      end as shift_end_ts
    from public.effective_work_shifts ews
    left join public.store_locations sl on sl.id = ews.store_id
    where ews.employee_id = _employee_id
      and (_store_id is null or ews.store_id = _store_id)
      and ews.work_date = (_ts at time zone coalesce(sl.timezone, 'America/New_York'))::date
      and ews.start_local is not null
      and ews.end_local is not null
  )
  select
    shift_start_ts as expected_start_ts,
    shift_end_ts as expected_end_ts
  from candidates
  order by
    case when _ts between shift_start_ts - interval '6 hours' and shift_end_ts + interval '6 hours' then 0 else 1 end,
    abs(extract(epoch from (shift_start_ts - _ts))) asc
  limit 1
$$;

create or replace function public.can_manage_inventory()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.employees e
    where e.user_id = auth.uid()
      and e.active is distinct from false
      and e.role in ('admin', 'manager', 'employee', 'seller')
  );
$$;

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
    and e.role in ('admin', 'manager', 'employee', 'seller')
    and (public.can_manage_inventory() or public.current_user_can_use_seller_schedule())
  order by coalesce(nullif(btrim(e.display_name), ''), e.email, 'Unnamed seller'), e.email;
$$;

create or replace function public.tr_time_entries_exceptions_ai()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  s record;
  v_grace_in integer;
  v_store_name text;
  v_body text;
begin
  if new.store_id is null then
    return new;
  end if;

  select sl.schedule_grace_in_m, sl.name into v_grace_in, v_store_name
  from public.store_locations sl
  where sl.id = new.store_id;

  select * into s
  from public.match_effective_shift_rule_a(new.employee_id, new.store_id, new.clock_in, 6);

  if s.shift_key is null then
    return new;
  end if;

  if s.source = 'seller_sale' then
    v_grace_in := 10;
  end if;

  if new.clock_in > (s.shift_start_ts + make_interval(mins => coalesce(v_grace_in, 0))) then
    begin
      insert into public.time_exception_alerts(alert_type, employee_id, store_id, ref_table, ref_id, shift_key)
      values ('late_in', new.employee_id, new.store_id, 'time_entries', new.id, s.shift_key);
    exception when unique_violation then
      return new;
    end;

    v_body :=
      'OG Jewelers exception' || E'\n' ||
      'Late clock-in detected.' || E'\n\n' ||
      'Employee: ' || (select display_name from public.employees where id = new.employee_id) || E'\n' ||
      'Store: ' || coalesce(v_store_name, 'N/A') || E'\n' ||
      'Scheduled: ' || to_char(s.start_local, 'HH12:MI AM') || E'\n' ||
      'Actual: ' || to_char(new.clock_in at time zone s.timezone, 'HH12:MI AM');

    perform public.enqueue_alert_sms(
      new.employee_id,
      new.store_id,
      v_body,
      jsonb_build_object(
        'type','time_exception',
        'alert_type','late_in',
        'time_entry_id', new.id,
        'shift_key', s.shift_key,
        'schedule_source', s.source
      )
    );
  end if;

  return new;
end;
$$;

create or replace function public.tr_time_breaks_exceptions_au()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  te record;
  sl record;
  v_cap interval;
  v_body text;
  v_duration interval;
  v_is_seller_shift boolean := false;
begin
  if old.ended_at is not null or new.ended_at is null then
    return new;
  end if;

  select * into te
  from public.time_entries
  where id = new.time_entry_id;

  if te.id is null or te.store_id is null then
    return new;
  end if;

  select * into sl
  from public.store_locations
  where id = te.store_id;

  select exists (
    select 1
    from public.seller_sale_shifts s
    where s.seller_employee_id = te.employee_id
      and s.store_id = te.store_id
      and s.status = any (public.seller_sale_active_statuses())
      and te.clock_in between s.start_at - interval '30 minutes' and s.end_at + interval '30 minutes'
  ) into v_is_seller_shift;

  if v_is_seller_shift then
    v_cap := interval '5 minutes';
  else
    v_cap := make_interval(mins => coalesce(sl.paid_break_cap_min, 30)) + interval '5 minutes';
  end if;

  v_duration := new.ended_at - new.started_at;

  if v_duration > v_cap then
    begin
      insert into public.time_exception_alerts(alert_type, employee_id, store_id, ref_table, ref_id)
      values ('break_long', te.employee_id, te.store_id, 'time_breaks', new.id);
    exception when unique_violation then
      return new;
    end;

    v_body :=
      'OG Jewelers exception' || E'\n' ||
      case when v_is_seller_shift then 'Seller break over 5 minutes.' else 'Break too long.' end || E'\n\n' ||
      'Employee: ' || (select display_name from public.employees where id = te.employee_id) || E'\n' ||
      'Store: ' || coalesce(sl.name,'N/A') || E'\n' ||
      'Duration: ' || trim(to_char(extract(epoch from v_duration)/60, '99990')) || ' min';

    perform public.enqueue_alert_sms(
      te.employee_id,
      te.store_id,
      v_body,
      jsonb_build_object(
        'type','time_exception',
        'alert_type','break_long',
        'time_break_id', new.id,
        'time_entry_id', te.id,
        'seller_sale_shift', v_is_seller_shift
      )
    );
  end if;

  return new;
end;
$$;

create or replace function public.scan_open_break_too_long_exceptions()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_cap interval;
  v_body text;
  v_minutes numeric;
  v_is_seller_shift boolean;
begin
  for r in
    select
      tb.id as break_id,
      tb.started_at,
      te.id as time_entry_id,
      te.employee_id,
      te.store_id,
      te.clock_in,
      sl.name as store_name,
      sl.paid_break_cap_min,
      sl.timezone
    from public.time_breaks tb
    join public.time_entries te on te.id = tb.time_entry_id
    join public.store_locations sl on sl.id = te.store_id
    where tb.ended_at is null
  loop
    if exists (
      select 1
      from public.time_exception_alerts a
      where a.alert_type = 'break_open_too_long'
        and a.ref_table = 'time_breaks'
        and a.ref_id = r.break_id
    ) then
      continue;
    end if;

    select exists (
      select 1
      from public.seller_sale_shifts s
      where s.seller_employee_id = r.employee_id
        and s.store_id = r.store_id
        and s.status = any (public.seller_sale_active_statuses())
        and r.clock_in between s.start_at - interval '30 minutes' and s.end_at + interval '30 minutes'
    ) into v_is_seller_shift;

    if v_is_seller_shift then
      v_cap := interval '5 minutes';
    else
      v_cap := make_interval(mins => coalesce(r.paid_break_cap_min, 30)) + interval '5 minutes';
    end if;

    if now() <= (r.started_at + v_cap) then
      continue;
    end if;

    insert into public.time_exception_alerts(alert_type, employee_id, store_id, ref_table, ref_id)
    values ('break_open_too_long', r.employee_id, r.store_id, 'time_breaks', r.break_id);

    v_minutes := round(extract(epoch from (now() - r.started_at)) / 60.0, 1);

    v_body :=
      'OG Jewelers exception' || E'\n' ||
      case when v_is_seller_shift then 'Seller break over 5 minutes (still open).' else 'Break over limit (still open).' end || E'\n\n' ||
      'Employee: ' || (select display_name from public.employees where id = r.employee_id) || E'\n' ||
      'Store: ' || r.store_name || E'\n' ||
      'Open for: ' || v_minutes::text || ' min';

    perform public.enqueue_alert_sms(
      r.employee_id,
      r.store_id,
      v_body,
      jsonb_build_object(
        'type','time_exception',
        'alert_type','break_open_too_long',
        'time_break_id', r.break_id,
        'time_entry_id', r.time_entry_id,
        'seller_sale_shift', v_is_seller_shift
      )
    );
  end loop;
end;
$$;

create or replace function public.prevent_seller_time_entry_hourly_approval()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1
    from public.time_entries te
    join public.employees e on e.id = te.employee_id
    where te.id = new.time_entry_id
      and e.active is distinct from false
      and lower(coalesce(e.role, '')) = 'seller'
  ) then
    raise exception 'Seller time entries are commission-only operational proof and cannot be approved for hourly payroll'
      using errcode = '22023';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_prevent_seller_time_entry_hourly_approval on public.shift_approvals;
create trigger trg_prevent_seller_time_entry_hourly_approval
before insert or update on public.shift_approvals
for each row execute function public.prevent_seller_time_entry_hourly_approval();

revoke all on function public.current_employee_id() from public;
revoke all on function public.current_employee_role() from public;
revoke all on function public.current_user_can_manage_sellers() from public;
revoke all on function public.current_user_can_use_seller_schedule() from public;
revoke all on function public.book_seller_sale_shift(text, uuid, timestamptz, timestamptz, text) from public;
revoke all on function public.request_seller_sale_shift_edit(uuid, text, uuid, timestamptz, timestamptz, text) from public;
revoke all on function public.cancel_seller_sale_shift(uuid, text) from public;
revoke all on function public.admin_review_seller_shift_request(uuid, text, text) from public;
revoke all on function public.admin_save_seller_sale_block(uuid, text, timestamptz, timestamptz, text, boolean) from public;
revoke all on function public.get_seller_schedule_month(date) from public;

grant execute on function public.current_employee_id() to authenticated;
grant execute on function public.current_employee_role() to authenticated;
grant execute on function public.current_user_can_manage_sellers() to authenticated;
grant execute on function public.current_user_can_use_seller_schedule() to authenticated;
grant execute on function public.book_seller_sale_shift(text, uuid, timestamptz, timestamptz, text) to authenticated;
grant execute on function public.request_seller_sale_shift_edit(uuid, text, uuid, timestamptz, timestamptz, text) to authenticated;
grant execute on function public.cancel_seller_sale_shift(uuid, text) to authenticated;
grant execute on function public.admin_review_seller_shift_request(uuid, text, text) to authenticated;
grant execute on function public.admin_save_seller_sale_block(uuid, text, timestamptz, timestamptz, text, boolean) to authenticated;
grant execute on function public.get_seller_schedule_month(date) to authenticated;

notify pgrst, 'reload schema';
