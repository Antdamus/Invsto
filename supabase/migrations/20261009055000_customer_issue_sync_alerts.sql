begin;
set local lock_timeout='3s';
set local statement_timeout='60s';
alter table public.task_notifications drop constraint task_notifications_notification_type_check;
alter table public.task_notifications add constraint task_notifications_notification_type_check check(notification_type in (
 'task_assigned','subtask_assigned','shipment_assigned','packaging_assigned','return_task_assigned','subtask_completed',
 'task_progress_update','task_completed','task_ready_for_review','task_due_tomorrow','task_due_today','task_overdue_assignee','task_overdue_assigner',
 'customer_issue_action','customer_issue_deadline','customer_issue_sync'));

create table public.customer_issue_sync_incidents(
 id uuid primary key default gen_random_uuid(),monitor_key text not null,reason text not null,
 opened_at timestamptz not null default now(),last_seen_at timestamptz not null default now(),resolved_at timestamptz
);
create unique index customer_issue_sync_one_incident on public.customer_issue_sync_incidents(monitor_key) where resolved_at is null;
create table public.customer_issue_sync_alert_recipients(
 incident_id uuid not null references public.customer_issue_sync_incidents(id),recipient_user_id uuid not null,
 notification_id uuid,primary key(incident_id,recipient_user_id)
);
alter table public.customer_issue_sync_incidents enable row level security;
alter table public.customer_issue_sync_alert_recipients enable row level security;
revoke all on public.customer_issue_sync_incidents,public.customer_issue_sync_alert_recipients from public,anon,authenticated;
grant all on public.customer_issue_sync_incidents,public.customer_issue_sync_alert_recipients to service_role;

create function public.customer_issue_sync_problems(_now timestamptz default now())
returns table(monitor_key text,reason text) language sql stable security definer set search_path='' as $$
 with worker as (select * from public.ebay_issue_worker where singleton),
 stalled as (select 1 from worker where coalesce(last_run_finished_at,monitoring_started_at)<_now-interval '10 minutes'),
 feeds as (
  select l.lane,case
   when l.status='needs_access' or exists(select 1 from public.ebay_issue_sync_jobs j where j.lane=l.lane and j.state='retry' and j.failure_kind='access') then 'access'
   when l.error_count>=3 or exists(select 1 from public.ebay_issue_sync_jobs j where j.lane=l.lane and j.state='retry' and j.attempts>=3) then 'failures'
   when coalesce(l.last_progress_at,(select monitoring_started_at from worker))<_now-interval '20 minutes' then 'stalled'
   when exists(select 1 from public.ebay_issue_sync_jobs j where j.lane=l.lane and j.state='queued' and j.next_attempt_at<=_now and j.enqueued_at<_now-interval '30 minutes') then 'backlog'
  end reason from public.ebay_issue_sync_lanes l
 ) select 'worker'::text,'stalled'::text from stalled
 union all select lane,reason from feeds where reason is not null and not exists(select 1 from stalled)
$$;

create function public.check_customer_issue_sync(_now timestamptz default now()) returns int
language plpgsql security definer set search_path='' as $$
declare problem record;incident public.customer_issue_sync_incidents;recipient public.employees;
 label text;alert_body text;notice uuid;notified int:=0;active_keys text[];
begin
 -- Separate from the HTTP worker: outages of that worker cannot silence this check.
 perform pg_advisory_xact_lock(hashtext('customer_issue_sync_health'));
 select coalesce(array_agg(monitor_key),'{}') into active_keys from public.customer_issue_sync_problems(_now);
 for incident in select * from public.customer_issue_sync_incidents where resolved_at is null and not(monitor_key=any(active_keys)) and (monitor_key='worker' or not('worker'=any(active_keys))) for update loop
  update public.customer_issue_sync_incidents set resolved_at=_now,last_seen_at=_now where id=incident.id;
  update public.task_notifications n set title='eBay sync restored',
   body='The sync problem has cleared. Automatic updates are running again. Open sync status to check the latest update times.',
   metadata=n.metadata||jsonb_build_object('resolved_at',_now)
  from public.customer_issue_sync_alert_recipients r where r.incident_id=incident.id and r.notification_id=n.id;
 end loop;
 for problem in select * from public.customer_issue_sync_problems(_now) loop
  insert into public.customer_issue_sync_incidents(monitor_key,reason,opened_at,last_seen_at)
   values(problem.monitor_key,problem.reason,_now,_now)
   on conflict(monitor_key) where resolved_at is null do update set reason=excluded.reason,last_seen_at=excluded.last_seen_at
   returning * into incident;
  label:=case problem.monitor_key when 'worker' then 'Customer issues' when 'return' then 'Returns' when 'inquiry' then 'Customer requests' when 'case' then 'Escalated cases' else 'Payment disputes' end;
  alert_body:=case problem.reason when 'access' then 'The eBay connection needs attention. An administrator should reconnect eBay, save the replacement refresh token, then retry sync.'
   when 'failures' then 'Updates have failed repeatedly. Open sync status to inspect affected cases and retry after correcting the reported problem.'
   when 'backlog' then 'Some case updates have waited more than 30 minutes. Open sync status to retry and review the queue.'
   else 'Automatic updates have stopped making progress. Open sync status and retry sync. If it stays stalled, check the scheduled worker in Supabase.' end;
  -- Keep one alert per administrator and outage. Reading it does not clear the
  -- underlying problem; the health banner stays until recovery is observed.
  for recipient in select distinct on(user_id) * from public.employees where active and role='admin' and user_id is not null order by user_id,id loop
   insert into public.customer_issue_sync_alert_recipients(incident_id,recipient_user_id) values(incident.id,recipient.user_id) on conflict do nothing;
   if found then
    notice:=public.create_task_notification(recipient.user_id,recipient.email,'return',incident.id,null,'customer_issue_sync',
     'eBay sync needs attention: '||label,alert_body,'high',null,
     jsonb_build_object('source','customer_issue_sync','incident_id',incident.id,'monitor_key',problem.monitor_key,'reason',problem.reason),null,null,null);
    update public.customer_issue_sync_alert_recipients set notification_id=notice where incident_id=incident.id and recipient_user_id=recipient.user_id;
    notified:=notified+1;
   else
    update public.task_notifications n set body=alert_body,metadata=n.metadata||jsonb_build_object('reason',problem.reason)
    from public.customer_issue_sync_alert_recipients r where r.incident_id=incident.id and r.recipient_user_id=recipient.user_id and r.notification_id=n.id
     and n.metadata->>'reason' is distinct from problem.reason;
   end if;
  end loop;
 end loop;
 return notified;
end $$;

create or replace function public.customer_issue_sync_health() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if not public.can_access_post_order_issues() then raise exception 'Customer issues access required' using errcode='42501';end if;
 return jsonb_build_object('lanes',(select jsonb_agg(to_jsonb(l) order by lane) from public.ebay_issue_sync_lanes l),
 'worker',(select jsonb_build_object('last_started_at',last_run_started_at,'last_finished_at',last_run_finished_at) from public.ebay_issue_worker where singleton),
 'problems',coalesce((select jsonb_agg(to_jsonb(p)) from public.customer_issue_sync_problems() p),'[]'),
 'queued',(select count(*) from public.ebay_issue_sync_jobs where state='queued'),
 'urgent',(select count(*) from public.ebay_issue_sync_jobs where state in ('queued','retry') and priority<0 and next_attempt_at<=now()),
 'retrying',(select count(*) from public.ebay_issue_sync_jobs where state='retry'),
 'manual_review',(select count(*) from public.ebay_issue_sync_jobs where state='retry' and failure_kind='review'),
 'failures',coalesce((select jsonb_agg(to_jsonb(x)) from (select j.lane,j.external_id,j.attempts,j.failure_kind,j.last_error,j.next_attempt_at,c.id case_id
 from public.ebay_issue_sync_jobs j left join public.ebay_return_cases c on c.source_lane=j.lane and c.ebay_return_id=j.external_id
 where j.state='retry' order by j.next_attempt_at limit 12) x),'[]'));
end $$;
revoke all on function public.customer_issue_sync_problems(timestamptz),public.check_customer_issue_sync(timestamptz) from public,anon,authenticated;
grant execute on function public.customer_issue_sync_problems(timestamptz),public.check_customer_issue_sync(timestamptz) to service_role;
commit;
