begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

-- Provider state, our physical workflow and task ownership are independent.
alter table public.ebay_return_cases
 add column if not exists source_lane text not null default 'return',
 add column if not exists issue_kind text not null default 'return',
 add column if not exists ebay_status text,
 add column if not exists ebay_action text,
 add column if not exists ebay_due_at timestamptz,
 add column if not exists synced_at timestamptz,
 add column if not exists provider_fingerprint text,
 add column if not exists last_sync_attempt_at timestamptz,
 add column if not exists sync_error text,
 add column if not exists item_title text,
 add column if not exists item_image_url text;
alter table public.ebay_return_cases add constraint customer_issue_kind_check check(issue_kind in ('request','return','dispute'));
alter table public.ebay_return_cases add constraint customer_issue_lane_check check(source_lane in ('return','inquiry','case','payment_dispute'));

-- Never infer a dispute from a generic task title or a customer's comment.
update public.ebay_return_cases set
 source_lane=case when coalesce(raw_payload->>'postOrderIssueLane',raw_payload#>>'{apiExtractedDetails,issueLane}') in ('inquiry','case','payment_dispute')
 then coalesce(raw_payload->>'postOrderIssueLane',raw_payload#>>'{apiExtractedDetails,issueLane}') else 'return' end,
 ebay_status=coalesce(raw_payload->>'returnStatus',raw_payload->>'returnState',raw_payload#>>'{apiExtractedDetails,status}'),
 ebay_action=coalesce(raw_payload->>'sellerActionDue',raw_payload->>'returnAction'),
 item_title=coalesce(raw_payload->>'itemTitle',raw_payload#>>'{apiExtractedDetails,itemTitle}'),
 item_image_url=nullif(coalesce(raw_payload->>'itemImageUrl',raw_payload#>>'{returnDetails,itemImageUrl}'),'');
update public.ebay_return_cases set issue_kind=case source_lane when 'inquiry' then 'request' when 'return' then 'return' else 'dispute' end;
-- Old observations have no certified freshness. A new successful provider read
-- sets synced_at; an old task timestamp must not masquerade as a fresh sync.
create index if not exists customer_issues_queue_idx on public.ebay_return_cases(issue_kind,ebay_due_at,opened_at desc);
create index if not exists customer_issues_external_idx on public.ebay_return_cases(source_lane,ebay_return_id);

create table public.ebay_issue_sync_lanes(
 lane text primary key check(lane in ('return','inquiry','case','payment_dispute')),
 cursor_offset int not null default 0, cycle_started_at timestamptz,
 last_success_at timestamptz,last_attempt_at timestamptz,next_run_at timestamptz not null default now(),
 total_entries int, fetched_entries int not null default 0,
 status text not null default 'pending',error text,error_count int not null default 0
);
insert into public.ebay_issue_sync_lanes(lane) values('return'),('inquiry'),('case'),('payment_dispute');
alter table public.ebay_issue_sync_lanes enable row level security;
create policy customer_issue_sync_read on public.ebay_issue_sync_lanes for select to authenticated using((select public.can_access_post_order_issues()));
grant select on public.ebay_issue_sync_lanes to authenticated;

create table public.ebay_issue_sync_jobs(
 lane text not null,external_id text not null,summary jsonb not null default '{}',
 state text not null default 'queued',attempts int not null default 0,
 next_attempt_at timestamptz not null default now(),last_error text,updated_at timestamptz not null default now(),
 primary key(lane,external_id)
);
create index customer_issue_jobs_due on public.ebay_issue_sync_jobs(next_attempt_at) where state in ('queued','retry');
alter table public.ebay_issue_sync_jobs enable row level security;
revoke all on public.ebay_issue_sync_jobs from public,anon,authenticated;
create table public.ebay_issue_worker(singleton boolean primary key default true check(singleton),dispatch_token uuid,lease_until timestamptz,claimed_at timestamptz);
insert into public.ebay_issue_worker(singleton) values(true);
alter table public.ebay_issue_worker enable row level security;
revoke all on public.ebay_issue_worker from public,anon,authenticated;
grant select,insert,update,delete on public.ebay_issue_sync_lanes,public.ebay_issue_sync_jobs,public.ebay_issue_worker to service_role;
create function public.claim_customer_issue_worker(_token uuid) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 update public.ebay_issue_worker set claimed_at=now() where singleton and dispatch_token=_token and _token is not null and claimed_at is null and lease_until>now();
 return found;
end $$;
revoke all on function public.claim_customer_issue_worker(uuid) from public,anon,authenticated;
grant execute on function public.claim_customer_issue_worker(uuid) to service_role;

-- List only light case summaries. Evidence/raw API payloads load on selection.
create function public.list_customer_issues(_view text default 'attention',_scope text default 'all',_search text default '',_offset int default 0,_limit int default 30)
returns jsonb language sql stable security invoker set search_path='' as $$
 with task_rows as (
  select t.return_case_id,t.id,t.status,t.assigned_to_user_id,t.assigned_by,t.created_by,t.due_at,t.priority,
   case when t.status in ('completed_by_employee','pending_admin_review','ready_for_admin_approval','waiting_on_admin') or t.metadata->>'request_kind'='decision'
    then public.task_workflow_reviewer(to_jsonb(t)) else t.assigned_to_user_id end next_user,
   t.status not in ('resolved','cancelled','closed','approved_by_admin') active
  from public.ebay_return_tasks t
 ), summaries as (
  select c.id,c.source_lane,c.issue_kind,c.ebay_return_id,c.order_id,c.order_number,c.buyer_username,c.return_reason,c.status,c.ebay_status,c.ebay_action,c.ebay_due_at,c.synced_at,c.sync_error,c.item_title,c.item_image_url,c.opened_at,c.updated_at,
   coalesce(ts.open_tasks,0) open_tasks,ts.next_user,ts.task_id,coalesce(ts.mine,false) mine,coalesce(ts.following,false) following,
   coalesce(ts.unassigned,true) unassigned,ts.follow_up_at,
   (c.status not in ('closed','cancelled') or coalesce(ts.open_tasks,0)>0) active,
   coalesce(c.ebay_due_at<now() and coalesce(c.ebay_status,'') !~* '(^|_)(CLOSED|CANCELLED|CANCELED|RESOLVED|SELLER_WON|SELLER_LOST|DISPUTE_REVERSED)($|_)',false) overdue,
   (c.synced_at is null or c.synced_at<now()-interval '30 minutes') stale
  from public.ebay_return_cases c left join lateral (
   select count(*) filter(where t.active)::int open_tasks,
    (array_agg(t.next_user order by t.active desc,t.due_at nulls last,t.id))[1] next_user,
    (array_agg(t.id order by t.active desc,t.due_at nulls last,t.id))[1] task_id,
    bool_or(t.active and t.next_user=auth.uid()) mine,
    bool_or(t.active and auth.uid() in (t.assigned_to_user_id,t.assigned_by,t.created_by) and t.next_user is distinct from auth.uid()) following,
    bool_or(t.active and t.next_user is null) unassigned,
    min(t.due_at) filter(where t.active) follow_up_at
   from task_rows t where t.return_case_id=c.id
  ) ts on true
  where public.can_access_post_order_issues()
   and (nullif(btrim(_search),'') is null or strpos(lower(concat_ws(' ',c.buyer_username,c.order_number,c.ebay_return_id,c.item_title,c.return_reason,c.return_tracking_number)),lower(btrim(_search)))>0)
 ), scoped as (
  select * from summaries where _scope='all' or (_scope='mine' and mine) or (_scope='following' and following) or (_scope='unassigned' and unassigned and active)
 ), filtered as (
  select * from scoped where case when _view='history' then not active else active and (_view='attention' or issue_kind=_view) end
 ), page as (
  select * from filtered order by overdue desc,case when coalesce(ebay_status,'') !~* '(^|_)(CLOSED|CANCELLED|CANCELED|RESOLVED|SELLER_WON|SELLER_LOST|DISPUTE_REVERSED)($|_)' then ebay_due_at end nulls last,follow_up_at nulls last,opened_at desc,id
  offset greatest(0,_offset) limit least(100,greatest(1,_limit))
 ) select jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(p)) from page p),'[]'),
  'total',(select count(*) from filtered),'counts',(select jsonb_build_object('attention',count(*) filter(where active),'request',count(*) filter(where active and issue_kind='request'),
  'return',count(*) filter(where active and issue_kind='return'),'dispute',count(*) filter(where active and issue_kind='dispute'),'history',count(*) filter(where not active)) from scoped))
$$;
revoke all on function public.list_customer_issues(text,text,text,int,int) from public,anon;
grant execute on function public.list_customer_issues(text,text,text,int,int) to authenticated;

-- A sync never closes a local task or throws away internal work. Finishing a
-- case is an explicit action after provider closure and physical reconciliation.
create function public.finish_customer_issue(_case_id uuid,_note text) returns void
language plpgsql security definer set search_path='' as $$
declare c public.ebay_return_cases;
begin
 if not public.is_admin() then raise exception 'An administrator must finish the case' using errcode='42501';end if;
 select * into c from public.ebay_return_cases where id=_case_id for update;
 if not found then raise exception 'Case not found';end if;
 if c.ebay_return_id is not null then
 if c.sync_error is not null or c.synced_at is null or c.synced_at<now()-interval '30 minutes' then raise exception 'Refresh the eBay case before finishing';end if;
 if coalesce(c.ebay_status,'') !~* '(^|_)(CLOSED|CANCELLED|CANCELED|RESOLVED|SELLER_WON|SELLER_LOST|DISPUTE_REVERSED)($|_)' then raise exception 'The eBay case is still open';end if;
 end if;
 if exists(select 1 from public.ebay_return_tasks where return_case_id=c.id and status not in ('resolved','cancelled','closed','approved_by_admin')) then raise exception 'Finish the remaining internal tasks first';end if;
 if exists(select 1 from public.ebay_return_items where return_case_id=c.id and ((received_quantity<expected_quantity and disposition<>'refund_only') or disposition in ('quarantine','admin_review','wrong_item','missing'))) then raise exception 'Returned items still need inspection or reconciliation';end if;
 if nullif(btrim(_note),'') is null then raise exception 'Add the outcome before finishing';end if;
 update public.ebay_return_cases set status='closed',closed_at=now(),updated_at=now() where id=c.id;
 insert into public.ebay_return_events(return_case_id,order_id,action,notes,signed_by,signed_by_email,payload)
 values(c.id,c.order_id,'closed',_note,auth.uid(),auth.jwt()->>'email',jsonb_build_object('source','customer_issues_explicit_finish','ebay_status',c.ebay_status));
end $$;
revoke all on function public.finish_customer_issue(uuid,text) from public,anon;
grant execute on function public.finish_customer_issue(uuid,text) to authenticated;

create function public.customer_issue_sync_health() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if not public.can_access_post_order_issues() then raise exception 'Customer issues access required' using errcode='42501';end if;
 return jsonb_build_object('lanes',(select jsonb_agg(to_jsonb(l) order by lane) from public.ebay_issue_sync_lanes l),
  'queued',(select count(*) from public.ebay_issue_sync_jobs where state='queued'),
  'retrying',(select count(*) from public.ebay_issue_sync_jobs where state='retry'));
end $$;
revoke all on function public.customer_issue_sync_health() from public,anon;
grant execute on function public.customer_issue_sync_health() to authenticated;

create function public.assign_customer_issue(_case_id uuid,_task_id uuid,_owner uuid,_kind text,_note text,_follow_up timestamptz default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare t public.ebay_return_tasks;previous text:=coalesce(current_setting('invsto.task_request_kind',true),'');
begin
 if not public.is_admin() then raise exception 'An administrator must assign this work' using errcode='42501';end if;
 if _kind not in ('work','decision') or _kind is null or _owner is null or nullif(btrim(_note),'') is null then raise exception 'Choose Work or Decision, the person responsible, and instructions';end if;
 if not exists(select 1 from public.employees where user_id=_owner and active is true) then raise exception 'Choose an active employee';end if;
 perform set_config('invsto.task_request_kind',_kind,true);
 if _task_id is null then
  select * into t from public.create_ebay_return_question_task(_case_id,_note,_owner,'normal',_follow_up,auth.jwt()->>'email');
 else
  select * into t from public.ebay_return_tasks where id=_task_id and return_case_id=_case_id for update;
  if not found or t.status in ('resolved','cancelled') then raise exception 'Choose an open task';end if;
  select * into t from public.assign_ebay_return_task(t.id,_owner,t.priority,_follow_up,_note,auth.jwt()->>'email');
 end if;
 update public.ebay_return_tasks set metadata=coalesce(metadata,'{}')||jsonb_build_object('request_kind',_kind),question=_note,due_at=_follow_up,status='assigned' where id=t.id;
 perform set_config('invsto.task_request_kind',previous,true);
 return t.id;
end $$;
revoke all on function public.assign_customer_issue(uuid,uuid,uuid,text,text,timestamptz) from public,anon;
grant execute on function public.assign_customer_issue(uuid,uuid,uuid,text,text,timestamptz) to authenticated;
commit;
