begin;
set local lock_timeout='5s';
create table public.ebay_hold_refund_reminders (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
 ref text not null, order_number text, case_id uuid references public.ebay_return_cases(id) on delete set null,
 due_day date not null, due_at timestamptz not null, sent_at timestamptz, cancelled_at timestamptz,
 unique(owner_id,ref)
);
create index refund_reminders_due on public.ebay_hold_refund_reminders(due_at) where sent_at is null and cancelled_at is null;
alter table public.ebay_hold_refund_reminders enable row level security;
revoke all on public.ebay_hold_refund_reminders from public,anon,authenticated;

create function public.my_hold_refund_reminders() returns jsonb language sql stable set search_path='' as $$
 select coalesce(jsonb_object_agg(ref,jsonb_build_object('day',due_day,'at',due_at,'sent',sent_at,'order',order_number)),'{}'::jsonb)
 from public.ebay_hold_refund_reminders where owner_id=auth.uid() and cancelled_at is null
 and (sent_at is null or sent_at>now()-interval '60 days')
$$;
revoke all on function public.my_hold_refund_reminders() from public,anon,authenticated;
do $$declare s text:=pg_get_functiondef('public.get_weekly_sales_for_market(date,text)'::regprocedure); marker text:='''ebay_return_hold_reviews'','; begin
 if strpos(s,marker)=0 then raise exception 'Unexpected weekly report'; end if;
 execute replace(s,marker,$q$'ebay_refund_reminders',case when _market in ('ebay','all') then public.my_hold_refund_reminders() end,$q$||marker);
end$$;

create function public.set_hold_refund_reminder(_ref text,_day date) returns jsonb
language plpgsql security definer set search_path='' as $$
declare entry jsonb; c uuid; prev public.ebay_hold_refund_reminders;
begin
 perform public.require_return_hold_admin();
 if _ref is null or _ref !~ '^[a-zA-Z0-9_-]{1,110}$' then raise exception 'Invalid return number'; end if;
 perform pg_advisory_xact_lock(hashtextextended('refund-reminder:'||auth.uid()||':'||_ref,0));
 select * into prev from public.ebay_hold_refund_reminders where owner_id=auth.uid() and ref=_ref for update;
 if _day is null then
  update public.ebay_hold_refund_reminders set cancelled_at=now() where id=prev.id and cancelled_at is null;
  return public.my_hold_refund_reminders();
 end if;
 if _day<(now() at time zone 'America/New_York')::date then raise exception 'Choose today or a future date in Eastern time.'; end if;
 select r into entry from public.ebay_account_holds h cross join lateral jsonb_array_elements(h.entries) r
 where h.singleton and r->>'kind'='return' and r->>'ref'=_ref;
 if entry is null and (prev.id is null or prev.cancelled_at is not null) then raise exception 'This return is no longer on hold.'; end if;
 select (array_agg(id))[1] into c from public.ebay_return_cases where source_lane='return' and issue_kind='return' and ebay_return_id=_ref
 and (coalesce(entry->>'oid',prev.order_number) is null or order_number is null or order_number=coalesce(entry->>'oid',prev.order_number)) having count(*)=1;
 c:=coalesce(c,prev.case_id);
 if (select marked from public.customer_return_money_marks where case_id=c order by revision desc limit 1) is true then raise exception 'Money is already marked returned for this return.'; end if;
 insert into public.ebay_hold_refund_reminders(owner_id,ref,case_id,order_number,due_day,due_at)
 values(auth.uid(),_ref,c,coalesce(entry->>'oid',prev.order_number),_day,(_day+time '09:00') at time zone 'America/New_York')
 on conflict(owner_id,ref) do update set due_day=excluded.due_day,due_at=excluded.due_at,case_id=excluded.case_id,
 order_number=excluded.order_number,cancelled_at=null,sent_at=null
 where ebay_hold_refund_reminders.due_day<>excluded.due_day or ebay_hold_refund_reminders.cancelled_at is not null;
 return public.my_hold_refund_reminders();
end$$;
revoke all on function public.set_hold_refund_reminder(text,date) from public,anon;
grant execute on function public.set_hold_refund_reminder(text,date) to authenticated;

do $$declare def text; s text; marker text:='when n.notification_type=''catalogue_request'''; begin
 select pg_get_constraintdef(oid) into strict def from pg_constraint where conrelid='public.task_notifications'::regclass and conname='task_notifications_notification_type_check';
 alter table public.task_notifications drop constraint task_notifications_notification_type_check;
 execute 'alter table public.task_notifications add constraint task_notifications_notification_type_check check(notification_type=''refund_reminder'' or '||substring(def from 7)||')';
 s:=pg_get_functiondef('public.notification_inbox(text,text,integer)'::regprocedure);
 if strpos(s,marker)=0 then raise exception 'Unexpected notification inbox'; end if;
 execute replace(s,marker,'when n.notification_type=''refund_reminder'' then ''returns'' '||marker);
end$$;

create function public.deliver_hold_refund_reminders() returns integer language plpgsql security definer set search_path='' as $$
declare r public.ebay_hold_refund_reminders; n integer:=0; cid uuid;
begin
 for r in select * from public.ebay_hold_refund_reminders where sent_at is null and cancelled_at is null and due_at<=now()
  order by due_at limit 250 for update skip locked loop
  cid:=r.case_id;
  if cid is null then select (array_agg(id))[1] into cid from public.ebay_return_cases where source_lane='return' and issue_kind='return'
   and ebay_return_id=r.ref and (r.order_number is null or order_number is null or order_number=r.order_number) having count(*)=1; end if;
  if not exists(select 1 from public.employees where user_id=r.owner_id and active and lower(role)='admin')
   or (select marked from public.customer_return_money_marks where case_id=cid order by revision desc limit 1) is true then
   update public.ebay_hold_refund_reminders set cancelled_at=now() where id=r.id; continue;
  end if;
  perform public.create_task_notification(r.owner_id,null,'return',r.id,null,'refund_reminder',
   'Refund reminder · Return '||r.ref,
   'You set a reminder to return the money by '||to_char(r.due_day,'Mon FMDD, YYYY')||'.'||coalesce(' Order '||r.order_number||'.',''),
   'normal',r.due_at,jsonb_strip_nulls(jsonb_build_object('case_id',cid,'return_ref',r.ref)),null,null,null);
  update public.ebay_hold_refund_reminders set sent_at=now(),case_id=cid where id=r.id;
  n:=n+1;
 end loop;
 return n;
end$$;
revoke all on function public.deliver_hold_refund_reminders() from public,anon,authenticated;
grant execute on function public.deliver_hold_refund_reminders() to service_role;
select cron.schedule('invsto-return-refund-reminders','* * * * *','select public.deliver_hold_refund_reminders();');
notify pgrst,'reload schema';
commit;
