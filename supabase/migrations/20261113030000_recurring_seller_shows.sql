-- Persistent weekly show patterns with a rolling 90-day booking window.
-- Individual edits/cancellations are preserved by the occurrence's unique key.
begin;
create table public.seller_show_recurrences (
  id uuid primary key default gen_random_uuid(),
  seller_employee_id uuid not null references public.employees(id),
  channel text not null check(channel in ('ebay','whatnot','tiktok')),
  store_id uuid not null references public.store_locations(id),
  weekdays integer[] not null check(cardinality(weekdays)>0 and weekdays <@ array[0,1,2,3,4,5,6]),
  start_local time not null,
  end_local time not null,
  ends_next_day boolean not null default false,
  effective_from date not null,
  effective_to date,
  active boolean not null default true,
  notes text,
  created_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  check(effective_to is null or effective_to>=effective_from),
  check(extract(minute from start_local) in(0,30) and extract(second from start_local)=0),
  check(extract(minute from end_local) in(0,30) and extract(second from end_local)=0),
  check((end_local-start_local+case when ends_next_day then interval '1 day' else interval '0 days' end) between interval '2 hours' and interval '24 hours')
);
alter table public.seller_show_recurrences enable row level security;
create policy seller_show_recurrences_read on public.seller_show_recurrences for select to authenticated
  using(public.current_user_can_manage_sellers() or seller_employee_id=public.current_employee_id());
grant select on public.seller_show_recurrences to authenticated;
grant all on public.seller_show_recurrences to service_role;

alter table public.seller_sale_shifts
  add column recurrence_id uuid references public.seller_show_recurrences(id),
  add column recurrence_date date;
create unique index seller_show_recurrence_occurrence on public.seller_sale_shifts(recurrence_id,recurrence_date)
  where recurrence_id is not null;

-- Assigned employee hosts can follow their reminder link without changing roles.
create or replace function public.current_user_can_use_seller_schedule()
returns boolean language sql stable security definer set search_path=public,pg_temp
as $$
  select exists(select 1 from public.employees e where e.user_id=auth.uid() and e.active is distinct from false
    and (lower(coalesce(e.role,'')) in ('admin','manager','seller')
      or (lower(coalesce(e.role,''))='employee' and (
        exists(select 1 from public.seller_sale_shifts s where s.seller_employee_id=e.id
          and s.end_at>now() and s.status=any(public.seller_sale_active_statuses()))
        or exists(select 1 from public.seller_show_recurrences r where r.seller_employee_id=e.id and r.active)
      ))));
$$;

create table public.seller_show_recurrence_conflicts (
  recurrence_id uuid not null references public.seller_show_recurrences(id) on delete cascade,
  show_date date not null,
  reason text not null,
  checked_at timestamptz not null default now(),
  primary key(recurrence_id,show_date)
);
alter table public.seller_show_recurrence_conflicts enable row level security;
create policy seller_show_recurrence_conflicts_read on public.seller_show_recurrence_conflicts for select to authenticated
  using(public.current_user_can_manage_sellers());
grant select on public.seller_show_recurrence_conflicts to authenticated;
grant all on public.seller_show_recurrence_conflicts to service_role;

create or replace function public.materialize_seller_show_recurrences(_through date default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$
declare
  r record; v_day date; v_today date; v_until date;
  v_start timestamptz; v_end timestamptz; v_count integer:=0; v_conflicts integer:=0;
begin
  perform pg_advisory_xact_lock(hashtext('seller_schedule_capacity'));
  for r in
    select sr.*,e.user_id,coalesce(nullif(sl.timezone,''),'America/New_York') as timezone
    from public.seller_show_recurrences sr
    join public.employees e on e.id=sr.seller_employee_id and e.active is distinct from false
    join public.store_locations sl on sl.id=sr.store_id and sl.active is true
    where sr.active order by sr.created_at,sr.id
  loop
    v_today:=(now() at time zone r.timezone)::date;
    v_until:=least(coalesce(_through,v_today+90),v_today+180,coalesce(r.effective_to,v_today+180));
    for v_day in select d::date from generate_series(greatest(v_today,r.effective_from)::timestamp,v_until::timestamp,interval '1 day') d
    loop
      if not (extract(dow from v_day)::integer=any(r.weekdays)) then continue;end if;
      -- A cancelled or individually moved occurrence still occupies its key.
      if exists(select 1 from public.seller_sale_shifts s where s.recurrence_id=r.id and s.recurrence_date=v_day) then
        delete from public.seller_show_recurrence_conflicts where recurrence_id=r.id and show_date=v_day;
        continue;
      end if;
      v_start:=(v_day+r.start_local) at time zone r.timezone;
      v_end:=((v_day+case when r.ends_next_day then 1 else 0 end)+r.end_local) at time zone r.timezone;
      if v_start<=now() then continue;end if;
      begin
        if v_end-v_start not between interval '2 hours' and interval '24 hours' then
          raise exception 'Show duration falls outside 2–24 hours on this timezone transition' using errcode='22023';
        end if;
        perform public.ensure_seller_sale_shift_available(r.seller_employee_id,r.channel,r.store_id,v_start,v_end,null);
        insert into public.seller_sale_shifts(seller_employee_id,seller_user_id,channel,store_id,start_at,end_at,notes,created_by,recurrence_id,recurrence_date,metadata)
        values(r.seller_employee_id,r.user_id,r.channel,r.store_id,v_start,v_end,r.notes,r.created_by,r.id,v_day,
          jsonb_build_object('scheduled_by_management',true,'recurrence_id',r.id,'recurrence_date',v_day,
            'recurrence_label','Repeats weekly','commission_rate',0.05,
            'commission_basis','net_store_proceeds_after_shipping_tax_platform_fees_returns','payout_day','friday'));
        v_count:=v_count+1;
        delete from public.seller_show_recurrence_conflicts where recurrence_id=r.id and show_date=v_day;
      exception when unique_violation or invalid_parameter_value then
        insert into public.seller_show_recurrence_conflicts(recurrence_id,show_date,reason)
          values(r.id,v_day,sqlerrm) on conflict(recurrence_id,show_date) do update set reason=excluded.reason,checked_at=now();
        v_conflicts:=v_conflicts+1;
      end;
    end loop;
  end loop;
  return jsonb_build_object('created',v_count,'conflicts',v_conflicts,'window_days',90);
end;
$$;

create or replace function public.admin_stop_seller_show_recurrence(_recurrence_id uuid,_reason text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_count integer;
begin
  if not public.current_user_can_manage_sellers() then raise exception 'Only managers can stop recurring shows' using errcode='42501';end if;
  perform pg_advisory_xact_lock(hashtext('seller_schedule_capacity'));
  update public.seller_show_recurrences set active=false,
    metadata=metadata||jsonb_build_object('stopped_at',now(),'stopped_by',auth.uid(),'stop_reason',_reason)
    where id=_recurrence_id;
  if not found then raise exception 'Recurring schedule not found' using errcode='P0002';end if;
  update public.seller_sale_shifts set status='cancelled',cancelled_at=now(),cancelled_by=auth.uid(),
    cancel_reason=coalesce(nullif(_reason,''),'Recurring schedule stopped')
    where recurrence_id=_recurrence_id and start_at>now() and status in('booked','edit_pending','cancel_pending');
  get diagnostics v_count=row_count;
  update public.seller_shift_change_requests q set status='cancelled',reviewed_at=now(),reviewed_by=auth.uid(),
    review_note='Recurring schedule stopped'
    from public.seller_sale_shifts s where q.shift_id=s.id and s.recurrence_id=_recurrence_id
      and s.start_at>now() and s.status='cancelled' and q.status='pending';
  delete from public.seller_show_recurrence_conflicts where recurrence_id=_recurrence_id and show_date>=current_date;
  return jsonb_build_object('status','stopped','cancelled_shows',v_count);
end;
$$;
revoke all on function public.materialize_seller_show_recurrences(date) from public,anon,authenticated;
grant execute on function public.materialize_seller_show_recurrences(date) to service_role;
revoke all on function public.admin_stop_seller_show_recurrence(uuid,text) from public,anon;
grant execute on function public.admin_stop_seller_show_recurrence(uuid,text) to authenticated;

-- Refill the rolling window daily; local timezone conversion preserves wall times.
select cron.schedule('materialize recurring seller shows','17 6 * * *',
  'select public.materialize_seller_show_recurrences();');
commit;
