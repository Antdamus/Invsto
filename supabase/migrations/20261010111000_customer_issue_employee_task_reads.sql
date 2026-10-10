begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

create or replace function public.list_customer_issues(_view text,_scope text,_search text,_offset int,_limit int,_sort text,_return_stage text)
returns jsonb language sql stable security invoker set search_path='' as $$
 with task_rows as (
  select t.return_case_id,t.id,t.status,t.assigned_to_user_id,t.assigned_by,t.created_by,t.due_at,t.priority,
   case when t.status='deferred' and t.metadata->>'customer_issue_watch'='true' then null when t.status in ('completed_by_employee','pending_admin_review','ready_for_admin_approval','waiting_on_admin') or t.metadata->>'request_kind'='decision'
    then public.customer_issue_task_reviewer(t.id) else t.assigned_to_user_id end next_user,
   (t.status='deferred' and t.metadata->>'customer_issue_watch'='true') watching,
   t.status not in ('resolved','cancelled','closed','approved_by_admin') active
  from public.employee_return_tasks t
 ), summaries as (
  select c.id,c.source_lane,c.issue_kind,c.ebay_return_id,c.order_id,c.order_number,c.buyer_username,c.return_reason,c.status,c.ebay_status,c.ebay_action,c.ebay_due_at,c.synced_at,c.sync_error,coalesce(nullif(c.item_title,''),price.item_title) item_title,c.item_image_url,c.opened_at,c.updated_at,o.sale_date order_placed_at,
   case when c.source_lane='payment_dispute' and c.raw_payload#>>'{ebayDetail,paymentDisputeId}'=c.ebay_return_id then c.raw_payload#>>'{ebayDetail,sellerResponse}' end seller_response,
   case when c.source_lane='payment_dispute' and c.raw_payload#>>'{ebayDetail,paymentDisputeId}'=c.ebay_return_id then c.raw_payload#>>'{ebayDetail,resolution,reasonForClosure}' end resolution_reason,
   case when c.source_lane='payment_dispute' and c.raw_payload#>>'{ebayDetail,paymentDisputeId}'=c.ebay_return_id then c.raw_payload#>>'{ebayDetail,resolution,protectionStatus}' end protection_status,
   coalesce(c.source_lane='payment_dispute' and c.ebay_status='OPEN' and c.raw_payload#>>'{ebayDetail,paymentDisputeId}'=c.ebay_return_id
    and c.raw_payload#>'{ebayDetail,availableChoices}'='[]'::jsonb and coalesce(c.raw_payload#>'{ebayDetail,sellerResponseDue}','{}'::jsonb) in ('{}'::jsonb,'null'::jsonb),false) dispute_no_response_needed,
   case when c.source_lane='case' and c.raw_payload#>>'{ebayDetail,caseId}'=c.ebay_return_id then jsonb_build_object(
    'caseId',c.ebay_return_id,'caseType',c.raw_payload#>>'{ebayDetail,caseType}',
    'nextSteps',c.raw_payload#>'{ebayDetail,nextSteps}',
    'caseContentOnHold',c.raw_payload#>'{ebayDetail,caseContentOnHold}',
    'sellerResponseDue',c.raw_payload#>'{ebayDetail,sellerResponseDue}') end provider_case,
   contact.data->>'customer_name' customer_name,
   case when c.issue_kind='return' then contact.data->>'shipping_name' end shipping_name,
   case when c.issue_kind='return' then contact.data->'shipping_address' end shipping_address,
   public.customer_issue_return_stage(c.issue_kind,c.status,c.ebay_status,c.raw_payload) return_stage,
   public.customer_issue_return_refund(c.source_lane,c.ebay_return_id,c.ebay_status,c.raw_payload) return_refund,
   public.customer_issue_return_refunded_at(c.source_lane,c.ebay_return_id,c.ebay_status,c.raw_payload) return_refunded_at,
   price.item_value,price.item_currency,price.linked_line_count,
   coalesce(ts.open_tasks,0) open_tasks,coalesce(ts.watching_tasks,0) watching_tasks,ts.next_user,ts.task_id,coalesce(ts.mine,false) mine,(coalesce(ts.following,false) or exists(select 1 from public.task_followers f join public.ebay_return_tasks watch on watch.id=f.task_id
    where f.source='return' and f.user_id=auth.uid() and watch.return_case_id=c.id and watch.status='deferred' and watch.metadata->>'customer_issue_watch'='true')) following,
   coalesce(ts.unassigned,false) unassigned,ts.follow_up_at,
   exists(select 1 from public.ebay_return_tasks tracker where tracker.return_case_id=c.id and tracker.status='deferred' and tracker.metadata->>'customer_issue_watch'='true') case_watching,
   (c.status not in ('closed','cancelled') or coalesce(ts.open_tasks,0)>0) active,
   coalesce(c.ebay_due_at<now() and coalesce(c.ebay_status,'') !~* '(^|_)(CLOSED|CANCELLED|CANCELED|RESOLVED|SELLER_WON|SELLER_LOST|DISPUTE_REVERSED)($|_)',false) overdue,
   (c.synced_at is null or c.synced_at<now()-interval '30 minutes') stale
  from public.ebay_return_cases c
  left join public.ebay_orders o on o.id=c.order_id
  left join lateral (select public.customer_issue_order_contact(o.buyer_name,o.raw_payload) data) contact on true
  left join lateral (
   select count(*)::int linked_line_count,string_agg(item_title,' · ' order by id) item_title,
    case when count(value)=count(*) and count(distinct currency)=1 then sum(value) end item_value,
    case when count(distinct currency)=1 then min(currency) end item_currency
   from (
    select l.id,l.item_title,nullif(l.sold_for,0)*l.quantity value,
     coalesce(nullif(l.raw_payload#>>'{line,total,currency}',''),nullif(l.raw_payload#>>'{line,lineItemCost,currency}',''),'USD') currency
    from public.ebay_order_lines l where l.order_id=c.order_id and (
     exists(select 1 from public.ebay_return_items i where i.return_case_id=c.id and i.order_line_id=l.id)
     or exists(select 1 from public.ebay_return_tasks t where t.return_case_id=c.id and l.id=any(t.order_line_ids))
     or coalesce(c.raw_payload->'manualOrderMatch'->'line_ids','[]') @> to_jsonb(array[l.id])
     or (not(c.raw_payload ? 'manualOrderMatch') and coalesce(c.raw_payload->'automaticOrderMatch'->'line_ids','[]') @> to_jsonb(array[l.id]))
    )
   ) matched
  ) price on true
  left join lateral (
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
   and (nullif(btrim(_search),'') is null or strpos(lower(concat_ws(' ',c.buyer_username,contact.data->>'customer_name',c.order_number,c.ebay_return_id,c.item_title,c.return_reason,c.return_tracking_number)),lower(btrim(_search)))>0)
 ), scoped as (
  select * from summaries where _scope='all' or (_scope='mine' and mine) or (_scope='following' and following) or (_scope='unassigned' and unassigned and active) or (_scope='due' and active and ebay_due_at<=now()+interval '48 hours' and public.customer_issue_requires_action(to_jsonb(summaries))) or (_scope='monitoring' and case_watching)
 ), filtered as (
  select * from scoped where case when _view='history' then not active else active and (_view='attention' or issue_kind=_view) end
   and (_view<>'return' or coalesce(_return_stage,'all')='all' or return_stage=_return_stage)
 ), page as (
  select * from filtered order by
   case when _sort='oldest' then opened_at end asc nulls last,
   case when _sort='order_newest' then order_placed_at end desc nulls last,
   case when _sort='order_oldest' then order_placed_at end asc nulls last,
   case when _sort='due_soonest' and coalesce(ebay_status,'') !~* '(^|_)(CLOSED|CANCELLED|CANCELED|RESOLVED|SELLER_WON|SELLER_LOST|DISPUTE_REVERSED)($|_)' then ebay_due_at end asc nulls last,
   case when _sort='due_latest' and coalesce(ebay_status,'') !~* '(^|_)(CLOSED|CANCELLED|CANCELED|RESOLVED|SELLER_WON|SELLER_LOST|DISPUTE_REVERSED)($|_)' then ebay_due_at end desc nulls last,
   case when _sort in ('value_highest','value_lowest') then item_value is null end asc,
   case when _sort in ('value_highest','value_lowest') then item_currency end asc nulls last,
   case when _sort='value_highest' then item_value end desc nulls last,
   case when _sort='value_lowest' then item_value end asc nulls last,
   opened_at desc nulls last,id
  offset greatest(0,_offset) limit least(100,greatest(1,_limit))
 ) select jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(p)) from page p),'[]'),
  'total',(select count(*) from filtered),'counts',(select jsonb_build_object('attention',count(*) filter(where active),'request',count(*) filter(where active and issue_kind='request'),
  'return',count(*) filter(where active and issue_kind='return'),'dispute',count(*) filter(where active and issue_kind='dispute'),'history',count(*) filter(where not active)) from scoped))
$$;
revoke all on function public.list_customer_issues(text,text,text,int,int,text,text) from public,anon;
grant execute on function public.list_customer_issues(text,text,text,int,int,text,text) to authenticated;


create or replace function public.customer_issue_task_notes(_case_ids uuid[],_limit int default 3,_offset int default 0)
returns jsonb language sql stable security invoker set search_path='' as $$
 with visible as materialized (
  select t.* from public.ebay_return_tasks t
  join public.ebay_return_cases c on c.id=t.return_case_id
  where c.id=any(_case_ids[1:100]) and (select auth.uid()) is not null
   and (select public.can_access_post_order_issues())
   -- Preserve authored and deliberately assigned work; exclude case trackers.
   and public.customer_issue_is_employee_task(to_jsonb(t))
   and (t.created_by is not null or nullif(btrim(t.created_by_email),'') is not null or t.assigned_by is not null)
   and t.metadata->>'history_removed_at' is null
   and lower(coalesce(t.metadata->>'hidden_from_task_board','false')) not in ('true','1','yes')
   and t.metadata->>'assignment_cancelled_at' is null
   and t.metadata->>'assignment_canceled_at' is null
 )
 select coalesce(jsonb_agg(jsonb_build_object('case_id',c.id,
  'task_count',(select count(*) from visible t where t.return_case_id=c.id),
  'tasks',coalesce((select jsonb_agg(to_jsonb(n) order by n.created_at desc,n.id desc) from (
   select t.id,t.title,t.question,t.latest_note,t.status,t.created_at,t.updated_at,
    t.created_by,t.created_by_email,t.assigned_by,t.assigned_to_user_id,t.assigned_to_email,
    jsonb_build_object('request_kind',t.metadata->'request_kind','customer_issue_watch',t.metadata->'customer_issue_watch') metadata,
    (select count(distinct concat(p->>'bucket',':',p->>'path'))
     from public.ebay_return_task_events e
     cross join lateral jsonb_array_elements(case when jsonb_typeof(e.photo_attachments)='array' then e.photo_attachments else '[]'::jsonb end) p
     where e.task_id=t.id and nullif(p->>'path','') is not null) attachment_count
   from visible t where t.return_case_id=c.id
   order by t.created_at desc,t.id desc limit least(50,greatest(1,coalesce(_limit,3))) offset greatest(0,coalesce(_offset,0))
  ) n),'[]'::jsonb))),'[]'::jsonb)
 from public.ebay_return_cases c where c.id=any(_case_ids[1:100])
  and (select auth.uid()) is not null and (select public.can_access_post_order_issues())
$$;
revoke all on function public.customer_issue_task_notes(uuid[],int,int) from public,anon;
grant execute on function public.customer_issue_task_notes(uuid[],int,int) to authenticated;
notify pgrst,'reload schema';
commit;
