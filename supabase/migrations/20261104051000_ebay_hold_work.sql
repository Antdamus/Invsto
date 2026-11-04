begin;
set local lock_timeout='5s';

-- Existing records keep their exact return ID. A dispute/retro hold with the
-- same external reference is a different record, even for the same order.
alter table public.ebay_return_hold_inspections add column hold_kind text not null default 'return' check(hold_kind in ('return','dispute','retro')),
 drop constraint ebay_return_hold_inspections_pkey, add primary key(hold_kind,ref,revision);
alter table public.ebay_return_hold_task_links add column hold_kind text not null default 'return' check(hold_kind in ('return','dispute','retro'));
alter table public.ebay_hold_refund_reminders add column hold_kind text not null default 'return' check(hold_kind in ('return','dispute','retro')),
 drop constraint ebay_hold_refund_reminders_owner_id_ref_key, add unique(owner_id,hold_kind,ref);
create table public.ebay_hold_notes (
 request_id uuid primary key, hold_kind text not null check(hold_kind in ('sale','return','dispute','retro','other')), ref text not null,
 body text not null check(length(btrim(body)) between 1 and 4000), actor uuid not null, signer text not null, recorded_at timestamptz not null default clock_timestamp()
);
create index ebay_hold_notes_by_entry on public.ebay_hold_notes(hold_kind,ref,recorded_at desc);
alter table public.ebay_hold_notes enable row level security;
revoke all on public.ebay_hold_notes from public,anon,authenticated;

create function public.ebay_hold_work(_kind text,_ref text) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('mark',(select jsonb_build_object('inspected',inspected,'revision',revision,'signer',signer,'at',recorded_at)
  from public.ebay_return_hold_inspections where hold_kind=_kind and ref=_ref order by revision desc limit 1),
 'tasks',coalesce((select jsonb_agg(jsonb_build_object('id',coalesce(t.id,g.id),'status',coalesce(t.status,g.status),
  'owner',coalesce(e.display_name,t.assigned_to_email,g.assigned_to_email)) order by l.created_at desc)
  from public.ebay_return_hold_task_links l left join public.ebay_return_tasks t on t.id=l.case_task
  left join public.team_tasks g on g.id=l.team_task left join public.employees e on e.user_id=coalesce(t.assigned_to_user_id,g.assigned_to_user_id)
  where l.hold_kind=_kind and l.ref=_ref),'[]'::jsonb),
 'notes',coalesce((select jsonb_agg(jsonb_build_object('id',request_id,'body',body,'signer',signer,'at',recorded_at) order by recorded_at desc,request_id)
  from public.ebay_hold_notes where hold_kind=_kind and ref=_ref),'[]'::jsonb))
$$;
create or replace function public.ebay_return_hold_review(_ref text) returns jsonb language sql stable set search_path='' as $$
 select public.ebay_hold_work('return',_ref)
$$;
create function public.ebay_current_hold(_kind text,_ref text) returns jsonb language sql stable set search_path='' as $$
 select r from public.ebay_account_holds h cross join lateral jsonb_array_elements(h.entries) r
 where h.singleton and r->>'kind'=_kind and r->>'ref'=_ref
$$;
create function public.ebay_hold_kind_label(_kind text) returns text language sql immutable set search_path='' as $$
 select case _kind when 'return' then 'Return' when 'dispute' then 'Payment dispute' when 'retro' then 'Sale funds held again' end
$$;
create function public.my_ebay_hold_reminders() returns jsonb language sql stable set search_path='' as $$
 select coalesce(jsonb_object_agg(hold_kind||':'||ref,jsonb_build_object('kind',hold_kind,'ref',ref,'day',due_day,'at',due_at,'sent',sent_at,'order',order_number)),'{}'::jsonb)
 from public.ebay_hold_refund_reminders where owner_id=auth.uid() and cancelled_at is null and (sent_at is null or sent_at>now()-interval '60 days')
$$;
create or replace function public.my_hold_refund_reminders() returns jsonb language sql stable set search_path='' as $$
 select coalesce(jsonb_object_agg(ref,jsonb_build_object('day',due_day,'at',due_at,'sent',sent_at,'order',order_number)),'{}'::jsonb)
 from public.ebay_hold_refund_reminders where hold_kind='return' and owner_id=auth.uid() and cancelled_at is null and (sent_at is null or sent_at>now()-interval '60 days')
$$;
create function public.ebay_current_hold_work() returns jsonb language sql stable set search_path='' as $$
 with touched as (select hold_kind,ref from public.ebay_hold_notes union select hold_kind,ref from public.ebay_return_hold_inspections
  union select hold_kind,ref from public.ebay_return_hold_task_links)
 select coalesce(jsonb_object_agg(t.hold_kind||':'||t.ref,public.ebay_hold_work(t.hold_kind,t.ref)),'{}'::jsonb)
 from public.ebay_account_holds h cross join lateral jsonb_array_elements(h.entries) r
 join touched t on t.hold_kind=r->>'kind' and t.ref=r->>'ref' where h.singleton
$$;
revoke all on function public.ebay_hold_work(text,text),public.ebay_current_hold(text,text),public.ebay_hold_kind_label(text),
 public.my_ebay_hold_reminders(),public.ebay_current_hold_work() from public,anon,authenticated;
do $$declare s text:=pg_get_functiondef('public.get_weekly_sales_for_market(date,text)'::regprocedure); marker text:='''ebay_refund_reminders'',';begin
 if strpos(s,marker)=0 then raise exception 'Unexpected weekly report';end if;
 execute replace(s,marker,$q$'ebay_hold_work',case when _market in ('ebay','all') then public.ebay_current_hold_work() end,
 'ebay_hold_reminders',case when _market in ('ebay','all') then public.my_ebay_hold_reminders() end,$q$||marker);
end$$;

create function public.add_ebay_hold_note(_request uuid,_kind text,_ref text,_note text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare old public.ebay_hold_notes; note text:=btrim(_note); who text;
begin
 perform public.require_return_hold_admin();
 if _request is null or nullif(note,'') is null or length(note)>4000 then raise exception 'Enter a note of up to 4,000 characters.';end if;
 perform pg_advisory_xact_lock(hashtextextended('hold-note:'||_request,0));
 select * into old from public.ebay_hold_notes where request_id=_request;
 if found then
  if (old.hold_kind,old.ref,old.actor,old.body) is distinct from (_kind,_ref,auth.uid(),note) then raise exception 'This note request was already used.';end if;
 else
  if public.ebay_current_hold(_kind,_ref) is null then raise exception 'This entry is no longer on hold. Refresh the report.';end if;
  select coalesce(nullif(btrim(display_name),''),email,auth.uid()::text) into who from public.employees where user_id=auth.uid() and active limit 1;
  insert into public.ebay_hold_notes(request_id,hold_kind,ref,body,actor,signer) values(_request,_kind,_ref,note,auth.uid(),who);
 end if;
 return public.ebay_hold_work(_kind,_ref);
end$$;
create function public.set_ebay_hold_inspected(_kind text,_ref text,_inspected boolean,_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare prior public.ebay_return_hold_inspections; who text;
begin
 perform public.require_return_hold_admin();
 if public.ebay_hold_kind_label(_kind) is null or _inspected is null or _revision is null or _revision<0 then raise exception 'Invalid hold inspection';end if;
 perform pg_advisory_xact_lock(hashtextextended('hold-review:'||_kind||':'||_ref,0));
 if public.ebay_current_hold(_kind,_ref) is null then raise exception 'This entry is no longer on hold. Refresh the report.';end if;
 select * into prior from public.ebay_return_hold_inspections where hold_kind=_kind and ref=_ref order by revision desc limit 1;
 if coalesce(prior.inspected,false)<>_inspected then
  if _revision<>coalesce(prior.revision,0) then raise exception 'This inspection changed. Refresh before trying again.';end if;
  select coalesce(nullif(btrim(display_name),''),email,auth.uid()::text) into who from public.employees where user_id=auth.uid() and active limit 1;
  insert into public.ebay_return_hold_inspections(hold_kind,ref,revision,inspected,actor,signer) values(_kind,_ref,_revision+1,_inspected,auth.uid(),who);
 end if;
 return public.ebay_hold_work(_kind,_ref);
end$$;
create or replace function public.set_return_hold_inspected(_ref text,_inspected boolean,_revision integer)
returns jsonb language sql security definer set search_path='' as $$select public.set_ebay_hold_inspected('return',_ref,_inspected,_revision)$$;

create function public.create_ebay_hold_task(_request uuid,_kind text,_ref text,_owner uuid,_note text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare entry jsonb; existing public.ebay_return_hold_task_links; signature jsonb; matched uuid[]; ct uuid; gt uuid; note text:=btrim(_note); context_line text;
begin
 perform public.require_return_hold_admin();
 if _request is null or _owner is null or public.ebay_hold_kind_label(_kind) is null or _ref is null or nullif(note,'') is null or length(note)>4000
  then raise exception 'Choose an employee and describe the follow-up (up to 4,000 characters).';end if;
 signature:=jsonb_build_object('ref',_ref,'owner',_owner,'note',note);
 perform pg_advisory_xact_lock(hashtextextended('return-hold-task:'||_request,0));
 select * into existing from public.ebay_return_hold_task_links where request_id=_request;
 if found then
  if existing.hold_kind<>_kind or existing.actor<>auth.uid() or existing.input<>signature then raise exception 'This task request was already used.';end if;
  return public.ebay_hold_work(_kind,_ref);
 end if;
 entry:=public.ebay_current_hold(_kind,_ref);
 if entry is null then raise exception 'This entry is no longer on hold. Refresh the report.';end if;
 context_line:=public.ebay_hold_kind_label(_kind)||' '||_ref||coalesce(' · Order '||(entry->>'oid'),'');
 select array_agg(id) into matched from public.ebay_return_cases where ebay_return_id=_ref
  and (_kind<>'return' or issue_kind='return')
  and source_lane=case _kind when 'return' then 'return' when 'dispute' then 'payment_dispute' end and status not in ('closed','cancelled')
  and (entry->>'oid' is null or order_number is null or order_number=entry->>'oid');
 if cardinality(matched)=1 and _kind='return' then ct:=public.request_customer_return_followup(_request,matched[1],_owner,'work',context_line||chr(10)||note,null);
 elsif cardinality(matched)=1 and _kind='dispute' then ct:=public.assign_customer_issue(matched[1],null,_owner,'work',context_line||chr(10)||note,null);
 else
  gt:=(public.create_task_request('team','work',jsonb_build_object('_title',context_line,'_description',note,'_task_type','customer_service',
   '_assigned_to_user_id',_owner,'_signed_by_email',auth.jwt()->>'email'))->>'id')::uuid;
 end if;
 insert into public.ebay_return_hold_task_links(request_id,hold_kind,ref,actor,input,case_task,team_task) values(_request,_kind,_ref,auth.uid(),signature,ct,gt);
 return public.ebay_hold_work(_kind,_ref);
end$$;
create or replace function public.create_return_hold_task(_request uuid,_ref text,_owner uuid,_note text)
returns jsonb language sql security definer set search_path='' as $$select public.create_ebay_hold_task(_request,'return',_ref,_owner,_note)$$;

create function public.set_ebay_hold_reminder(_kind text,_ref text,_day date) returns jsonb language plpgsql security definer set search_path='' as $$
declare entry jsonb; c uuid; prev public.ebay_hold_refund_reminders;
begin
 perform public.require_return_hold_admin();
 if public.ebay_hold_kind_label(_kind) is null or _ref is null or _ref !~ '^[a-zA-Z0-9_-]{1,110}$' then raise exception 'Invalid hold';end if;
 perform pg_advisory_xact_lock(hashtextextended('hold-reminder:'||auth.uid()||':'||_kind||':'||_ref,0));
 select * into prev from public.ebay_hold_refund_reminders where owner_id=auth.uid() and hold_kind=_kind and ref=_ref for update;
 if _day is null then update public.ebay_hold_refund_reminders set cancelled_at=now() where id=prev.id and cancelled_at is null;
 else
  if _day<(now() at time zone 'America/New_York')::date then raise exception 'Choose today or a future date in Eastern time.';end if;
  entry:=public.ebay_current_hold(_kind,_ref);
  if entry is null and (prev.id is null or prev.cancelled_at is not null) then raise exception 'This entry is no longer on hold.';end if;
  select (array_agg(id))[1] into c from public.ebay_return_cases where ebay_return_id=_ref
   and (_kind<>'return' or issue_kind='return')
   and source_lane=case _kind when 'return' then 'return' when 'dispute' then 'payment_dispute' end
   and (coalesce(entry->>'oid',prev.order_number) is null or order_number is null or order_number=coalesce(entry->>'oid',prev.order_number)) having count(*)=1;
  c:=coalesce(c,prev.case_id);
  if _kind='return' and (select marked from public.customer_return_money_marks where case_id=c order by revision desc limit 1) is true then raise exception 'Money is already marked returned for this return.';end if;
  insert into public.ebay_hold_refund_reminders(owner_id,hold_kind,ref,case_id,order_number,due_day,due_at)
   values(auth.uid(),_kind,_ref,c,coalesce(entry->>'oid',prev.order_number),_day,(_day+time '09:00') at time zone 'America/New_York')
   on conflict(owner_id,hold_kind,ref) do update set due_day=excluded.due_day,due_at=excluded.due_at,case_id=excluded.case_id,
    order_number=excluded.order_number,cancelled_at=null,sent_at=null
   where ebay_hold_refund_reminders.due_day<>excluded.due_day or ebay_hold_refund_reminders.cancelled_at is not null;
 end if;
 return public.my_ebay_hold_reminders();
end$$;
create or replace function public.set_hold_refund_reminder(_ref text,_day date) returns jsonb language plpgsql security definer set search_path='' as $$
begin perform public.set_ebay_hold_reminder('return',_ref,_day);return public.my_hold_refund_reminders();end$$;

do $$declare def text; s text; marker text:='when n.notification_type=''refund_reminder''';begin
 select pg_get_constraintdef(oid) into strict def from pg_constraint where conrelid='public.task_notifications'::regclass and conname='task_notifications_notification_type_check';
 alter table public.task_notifications drop constraint task_notifications_notification_type_check;
 execute 'alter table public.task_notifications add constraint task_notifications_notification_type_check check(notification_type=''hold_review_reminder'' or '||substring(def from 7)||')';
 s:=pg_get_functiondef('public.notification_inbox(text,text,integer)'::regprocedure);
 if strpos(s,marker)=0 then raise exception 'Unexpected notification inbox';end if;
 execute replace(s,marker,'when n.notification_type=''hold_review_reminder'' then ''buyers'' '||marker);
end$$;
create or replace function public.deliver_hold_refund_reminders() returns integer language plpgsql security definer set search_path='' as $$
declare r public.ebay_hold_refund_reminders; n integer:=0; cid uuid;
begin
 for r in select * from public.ebay_hold_refund_reminders where sent_at is null and cancelled_at is null and due_at<=now()
  order by due_at limit 250 for update skip locked loop
  cid:=r.case_id;
  if cid is null then select (array_agg(id))[1] into cid from public.ebay_return_cases where source_lane=case r.hold_kind when 'return' then 'return' when 'dispute' then 'payment_dispute' end
   and (r.hold_kind<>'return' or issue_kind='return')
   and ebay_return_id=r.ref and (r.order_number is null or order_number is null or order_number=r.order_number) having count(*)=1;end if;
  if not exists(select 1 from public.employees where user_id=r.owner_id and active and lower(role)='admin')
   or (r.hold_kind='return' and (select marked from public.customer_return_money_marks where case_id=cid order by revision desc limit 1) is true) then
   update public.ebay_hold_refund_reminders set cancelled_at=now() where id=r.id;continue;
  end if;
  if r.hold_kind='return' then
   perform public.create_task_notification(r.owner_id,null,'return',r.id,null,'refund_reminder','Refund reminder · Return '||r.ref,
    'You set a reminder to return the money by '||to_char(r.due_day,'Mon FMDD, YYYY')||'.'||coalesce(' Order '||r.order_number||'.',''),
    'normal',r.due_at,jsonb_strip_nulls(jsonb_build_object('case_id',cid,'return_ref',r.ref)),null,null,null);
  else
   perform public.create_task_notification(r.owner_id,null,'return',r.id,null,'hold_review_reminder',public.ebay_hold_kind_label(r.hold_kind)||' · Follow-up due',
    'Review hold '||r.ref||coalesce(' for order '||r.order_number,'')||'. Reminder date: '||to_char(r.due_day,'Mon FMDD, YYYY')||'.',
    'normal',r.due_at,jsonb_strip_nulls(jsonb_build_object('case_id',cid,'hold_kind',r.hold_kind,'hold_ref',r.ref,'order_number',r.order_number)),null,null,null);
  end if;
  update public.ebay_hold_refund_reminders set sent_at=now(),case_id=cid where id=r.id;n:=n+1;
 end loop;return n;
end$$;
revoke all on function public.add_ebay_hold_note(uuid,text,text,text),public.set_ebay_hold_inspected(text,text,boolean,integer),
 public.create_ebay_hold_task(uuid,text,text,uuid,text),public.set_ebay_hold_reminder(text,text,date) from public,anon;
grant execute on function public.add_ebay_hold_note(uuid,text,text,text),public.set_ebay_hold_inspected(text,text,boolean,integer),
 public.create_ebay_hold_task(uuid,text,text,uuid,text),public.set_ebay_hold_reminder(text,text,date) to authenticated;
notify pgrst,'reload schema';
commit;
