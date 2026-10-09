begin;
create or replace function public.list_customer_issues(_view text default 'attention',_scope text default 'all',_search text default '',_offset int default 0,_limit int default 30)
returns jsonb language sql stable security invoker set search_path='' as $$
 with task_rows as (
  select t.return_case_id,t.id,t.status,t.assigned_to_user_id,t.assigned_by,t.created_by,t.due_at,t.priority,
   case when t.status='deferred' and t.metadata->>'customer_issue_watch'='true' then null when t.status in ('completed_by_employee','pending_admin_review','ready_for_admin_approval','waiting_on_admin') or t.metadata->>'request_kind'='decision'
    then public.customer_issue_task_reviewer(t.id) else t.assigned_to_user_id end next_user,
   (t.status='deferred' and t.metadata->>'customer_issue_watch'='true') watching,
   t.status not in ('resolved','cancelled','closed','approved_by_admin') active
  from public.ebay_return_tasks t
 ), summaries as (
  select c.id,c.source_lane,c.issue_kind,c.ebay_return_id,c.order_id,c.order_number,c.buyer_username,c.return_reason,c.status,c.ebay_status,c.ebay_action,c.ebay_due_at,c.synced_at,c.sync_error,c.item_title,c.item_image_url,c.opened_at,c.updated_at,
   coalesce(ts.open_tasks,0) open_tasks,coalesce(ts.watching_tasks,0) watching_tasks,ts.next_user,ts.task_id,coalesce(ts.mine,false) mine,coalesce(ts.following,false) following,
   coalesce(ts.unassigned,true) unassigned,ts.follow_up_at,
   (c.status not in ('closed','cancelled') or coalesce(ts.open_tasks,0)>0) active,
   coalesce(c.ebay_due_at<now() and coalesce(c.ebay_status,'') !~* '(^|_)(CLOSED|CANCELLED|CANCELED|RESOLVED|SELLER_WON|SELLER_LOST|DISPUTE_REVERSED)($|_)',false) overdue,
   (c.synced_at is null or c.synced_at<now()-interval '30 minutes') stale
  from public.ebay_return_cases c left join lateral (
   select count(*) filter(where t.active)::int open_tasks,count(*) filter(where t.active and t.watching)::int watching_tasks,
    (array_agg(t.next_user order by (t.active and not coalesce(t.watching,false)) desc,t.active desc,t.due_at nulls last,t.id))[1] next_user,
    (array_agg(t.id order by (t.active and not coalesce(t.watching,false)) desc,t.active desc,t.due_at nulls last,t.id))[1] task_id,
    bool_or(t.active and t.next_user=auth.uid()) mine,
    bool_or(t.active and (auth.uid() in (t.assigned_to_user_id,t.assigned_by,t.created_by) or exists(select 1 from public.task_followers f where f.source='return' and f.task_id=t.id and f.user_id=auth.uid())) and t.next_user is distinct from auth.uid()) following,
    bool_or(t.active and not coalesce(t.watching,false) and t.next_user is null) unassigned,
    min(t.due_at) filter(where t.active) follow_up_at
   from task_rows t where t.return_case_id=c.id
  ) ts on true
  where public.can_access_post_order_issues()
   and (nullif(btrim(_search),'') is null or strpos(lower(concat_ws(' ',c.buyer_username,c.order_number,c.ebay_return_id,c.item_title,c.return_reason,c.return_tracking_number)),lower(btrim(_search)))>0)
 ), scoped as (
  select * from summaries where _scope='all' or (_scope='mine' and mine) or (_scope='following' and following) or (_scope='unassigned' and unassigned and active) or (_scope='due' and active and ebay_due_at<=now()+interval '48 hours' and public.customer_issue_requires_action(to_jsonb(summaries))) or (_scope='monitoring' and watching_tasks>0)
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


create or replace function public.customer_issue_sync_health() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if not public.can_access_post_order_issues() then raise exception 'Customer issues access required' using errcode='42501';end if;
 return jsonb_build_object('lanes',(select jsonb_agg(to_jsonb(l) order by lane) from public.ebay_issue_sync_lanes l),
 'queued',(select count(*) from public.ebay_issue_sync_jobs where state='queued'),
 'retrying',(select count(*) from public.ebay_issue_sync_jobs where state='retry'),
 'manual_review',(select count(*) from public.ebay_issue_sync_jobs where state='retry' and failure_kind='review'),
 'failures',coalesce((select jsonb_agg(to_jsonb(x)) from (select j.lane,j.external_id,j.attempts,j.failure_kind,j.last_error,j.next_attempt_at,c.id case_id
 from public.ebay_issue_sync_jobs j left join public.ebay_return_cases c on c.source_lane=j.lane and c.ebay_return_id=j.external_id
 where j.state='retry' order by j.next_attempt_at limit 12) x),'[]'));
end $$;
commit;
