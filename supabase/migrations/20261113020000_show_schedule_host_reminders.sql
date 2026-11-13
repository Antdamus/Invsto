-- Show reminders share the existing employee SMS outbox and dispatcher.
-- Only the assigned host's SMS-enabled phone is eligible; no manager fallback.
begin;

create unique index if not exists sms_outbox_show_reminder_once
  on public.sms_outbox ((meta->>'shift_id'), (meta->>'show_start_at'))
  where meta->>'type' = 'seller_show_reminder' and status <> 'cancelled';

create or replace function public.seller_show_sms_is_current(_meta jsonb, _phone text)
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.seller_sale_shifts s
    join public.employees e on e.id = s.seller_employee_id and e.active is distinct from false
    join public.user_phones p on p.user_id = e.user_id and p.can_sms is true
    where s.id::text = _meta->>'shift_id'
      and s.seller_employee_id::text = _meta->>'employee_id'
      and s.store_id::text = _meta->>'store_id'
      and s.channel = _meta->>'channel'
      and to_char(s.start_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') = _meta->>'show_start_at'
      and to_char(s.end_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') = _meta->>'show_end_at'
      and s.status in ('booked','edit_pending','cancel_pending')
      and s.start_at > now()
      and p.phone_e164 = _phone
  );
$$;

create or replace function public.cancel_stale_seller_show_sms()
returns void language sql security definer set search_path = public, pg_temp
as $$
  update public.sms_outbox o set status = 'cancelled',
    last_error = 'Show changed, cancelled, already started, or host SMS is unavailable.'
  where o.status = 'pending' and o.meta->>'type' = 'seller_show_reminder'
    and not public.seller_show_sms_is_current(o.meta, o.to_phone);
$$;

create or replace function public.invalidate_seller_show_sms()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' or
    (new.seller_employee_id,new.start_at,new.end_at,new.channel,new.store_id,new.status)
      is distinct from
    (old.seller_employee_id,old.start_at,old.end_at,old.channel,old.store_id,old.status)
  then
    update public.sms_outbox set status = 'cancelled', last_error = 'Show schedule changed.'
      where status = 'pending' and meta->>'type' = 'seller_show_reminder'
        and meta->>'shift_id' = old.id::text;
  end if;
  return null;
end;
$$;
drop trigger if exists trg_invalidate_seller_show_sms on public.seller_sale_shifts;
create trigger trg_invalidate_seller_show_sms after update or delete on public.seller_sale_shifts
  for each row execute function public.invalidate_seller_show_sms();

create or replace function public.enqueue_seller_show_reminders()
returns integer language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  r record;
  v_body text;
  v_count integer := 0;
  v_inserted integer;
begin
  perform pg_advisory_xact_lock(hashtext('seller_show_sms_reminders'));
  perform public.cancel_stale_seller_show_sms();
  for r in
    select s.*, e.display_name, p.phone_e164, sl.name as store_name,
      coalesce(nullif(sl.timezone,''),'America/New_York') as timezone
    from public.seller_sale_shifts s
    join public.employees e on e.id=s.seller_employee_id and e.active is distinct from false
    join public.user_phones p on p.user_id=e.user_id and p.can_sms is true
    join public.store_locations sl on sl.id=s.store_id
    where s.status in ('booked','edit_pending','cancel_pending')
      and s.start_at > now() and s.start_at <= now() + interval '30 minutes'
      and p.phone_e164 ~ '^\+[0-9]{7,15}$'
    order by s.start_at, s.id
    for update of s skip locked
  loop
    v_body := 'OG Jewelry show reminder' || E'\n'
      || 'Hi ' || left(coalesce(nullif(r.display_name,''),'there'),40) || ', your '
      || case r.channel when 'ebay' then 'eBay' when 'whatnot' then 'Whatnot' when 'tiktok' then 'TikTok' else r.channel end
      || ' show starts soon.' || E'\n'
      || to_char(r.start_at at time zone r.timezone,'Dy Mon DD, HH12:MI AM') || ' - '
      || case when (r.start_at at time zone r.timezone)::date <> (r.end_at at time zone r.timezone)::date
        then to_char(r.end_at at time zone r.timezone,'Dy Mon DD, HH12:MI AM')
        else to_char(r.end_at at time zone r.timezone,'HH12:MI AM') end
      || ' (' || r.timezone || ')' || E'\n'
      || 'Studio: ' || left(coalesce(r.store_name,'Your scheduled studio'),60) || E'\n'
      || 'Schedule: https://antdamus.github.io/Invsto/seller-dashboard.html';
    insert into public.sms_outbox(to_phone,body,send_after,status,meta)
    values(r.phone_e164,left(v_body,480),now(),'pending',jsonb_build_object(
      'type','seller_show_reminder','notification_type','show_starts_30_min',
      'schedule_source','seller_sale','seller_sale_shift',true,
      'shift_id',r.id,'employee_id',r.seller_employee_id,'store_id',r.store_id,'channel',r.channel,
      'show_start_at',to_char(r.start_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'show_end_at',to_char(r.end_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'reminder_minutes',30))
    on conflict do nothing;
    get diagnostics v_inserted = row_count;
    v_count := v_count + v_inserted;
  end loop;
  return v_count;
end;
$$;

create or replace function public.get_seller_show_sms_readiness()
returns table(seller_employee_id uuid, sms_ready boolean, phone_last_four text, reason text)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if not public.current_user_can_use_seller_schedule() then
    raise exception 'Not allowed to view show reminder setup' using errcode='42501';
  end if;
  return query select e.id,
    coalesce(p.can_sms is true and p.phone_e164 ~ '^\+[0-9]{7,15}$',false),
    case when p.phone_e164 is not null then right(p.phone_e164,4) else null end,
    case when e.user_id is null then 'no_login'
      when p.phone_e164 is null then 'missing_phone'
      when p.can_sms is not true then 'sms_disabled'
      when p.phone_e164 !~ '^\+[0-9]{7,15}$' then 'invalid_phone'
      else 'ready' end
  from public.employees e left join public.user_phones p on p.user_id=e.user_id
  where e.active is distinct from false
    and (public.current_user_can_manage_sellers() or e.user_id=auth.uid());
end;
$$;

-- Recheck show reminders immediately before the established dispatcher claims them.
-- All other employee/task/customer message routing remains unchanged.
create or replace function public.sms_outbox_claim(_batch integer default 25)
returns setof public.sms_outbox language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform public.cancel_stale_seller_show_sms();
  return query update public.sms_outbox o
  set status='sending', attempts=o.attempts+1
  where o.id in (
    select q.id from public.sms_outbox q
    where q.status='pending' and q.send_after<=now()
      and (q.meta->>'type' is distinct from 'seller_show_reminder'
        or public.seller_show_sms_is_current(q.meta,q.to_phone))
    order by q.send_after asc limit _batch for update skip locked
  ) returning o.*;
end;
$$;

-- The existing 30-second worker-reminder job calls this RPC. Keep ordinary shift
-- reminders and route seller shows through the host-specific, deduplicated queue.
create or replace function public.enqueue_upcoming_shift_reminders()
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  r record; v_user_id uuid; v_phone text; v_shift_start timestamptz; v_body text;
begin
  perform public.enqueue_seller_show_reminders();
  for r in
    select ews.employee_id,ews.work_date,ews.start_local,ews.end_local,ews.store_id,
      sl.name as store_name,sl.timezone
    from public.effective_work_shifts ews
    join public.store_locations sl on sl.id=ews.store_id
    where ews.source <> 'seller_sale'
      and not exists(select 1 from public.shift_sms_reminders sr
        where sr.employee_id=ews.employee_id and sr.work_date=ews.work_date
          and sr.start_local=ews.start_local and sr.end_local=ews.end_local
          and sr.store_id is not distinct from ews.store_id and sr.reminder_type='shift_30_min')
  loop
    v_shift_start := (r.work_date+r.start_local) at time zone r.timezone;
    if v_shift_start > now()+interval '30 minutes' then continue; end if;
    select e.user_id into v_user_id from public.employees e where e.id=r.employee_id;
    if v_user_id is null then continue; end if;
    select p.phone_e164 into v_phone from public.user_phones p where p.user_id=v_user_id and p.can_sms=true;
    if v_phone is null then continue; end if;
    v_body := 'OG Jewelers reminder' || E'\n' || 'Your shift starts soon.' || E'\n\n'
      || 'Date: ' || to_char(r.work_date,'Dy Mon DD, YYYY') || E'\n'
      || 'Time: ' || to_char(r.start_local,'HH12:MI AM') || ' – ' || to_char(r.end_local,'HH12:MI AM') || E'\n'
      || 'Location: ' || r.store_name;
    insert into public.sms_outbox(to_phone,body,send_after,status,meta)
      values(v_phone,v_body,greatest(now(),v_shift_start-interval '30 minutes'),'pending',
        jsonb_build_object('type','shift_30_min_reminder','employee_id',r.employee_id,'work_date',r.work_date,
          'start_local',r.start_local,'end_local',r.end_local,'store_id',r.store_id));
    insert into public.shift_sms_reminders(employee_id,work_date,start_local,end_local,store_id)
      values(r.employee_id,r.work_date,r.start_local,r.end_local,r.store_id);
  end loop;
end;
$$;

revoke all on function public.seller_show_sms_is_current(jsonb,text), public.cancel_stale_seller_show_sms(),
  public.invalidate_seller_show_sms(), public.enqueue_seller_show_reminders() from public,anon,authenticated;
grant execute on function public.enqueue_seller_show_reminders() to service_role;
revoke all on function public.get_seller_show_sms_readiness() from public,anon;
grant execute on function public.get_seller_show_sms_readiness() to authenticated;
commit;
