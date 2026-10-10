begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

-- A snapshot of this user's already-arrived case alerts. The UI acknowledges
-- these exact IDs only after rendering the case, never alerts arriving later.
create function public.customer_issue_notification_ids(_case_id uuid)
returns uuid[] language sql stable security invoker set search_path='' as $$
 select coalesce(array_agg(n.id),'{}'::uuid[])
 from public.task_notifications n
 where auth.uid() is not null and public.can_access_post_order_issues()
  and n.recipient_user_id=auth.uid() and n.read_at is null
  and n.notification_type in ('customer_issue_action','customer_issue_deadline')
  and exists(select 1 from public.ebay_return_cases c where c.id=_case_id)
  and (n.metadata->>'case_id'=_case_id::text or
   (n.metadata->>'case_id' is null and n.source='return' and exists(
    select 1 from public.ebay_return_tasks t where t.id=n.task_id and t.return_case_id=_case_id)))
$$;
revoke all on function public.customer_issue_notification_ids(uuid) from public,anon;
grant execute on function public.customer_issue_notification_ids(uuid) to authenticated;

-- Reuse the complete filtered/sorted queue to locate a deep-linked case's
-- page. The user can continue to its neighbors instead of a one-case search.
do $$
declare src text; original text;
begin
 src:=pg_get_functiondef('public.list_customer_issues(text,text,text,integer,integer,text,text)'::regprocedure);
 original:=src;
 src:=replace(src,'_return_stage text)', '_return_stage text, _focus_case_id uuid)');
 src:=replace(src, '), page as ('||chr(10)||'  select * from filtered order by',
  '), ranked as ('||chr(10)||'  select *,row_number() over(order by');
 src:=replace(src, 'opened_at desc nulls last,id'||chr(10)||'  offset greatest(0,_offset) limit least(100,greatest(1,_limit))',
  'opened_at desc nulls last,id)-1 as focus_position from filtered'||chr(10)||
  ' ), position as (select coalesce((select (focus_position / least(100,greatest(1,_limit))) * least(100,greatest(1,_limit)) from ranked where id=_focus_case_id),greatest(0,_offset))::int as page_offset),'||chr(10)||
  ' page as (select * from ranked order by focus_position offset (select page_offset from position) limit least(100,greatest(1,_limit))');
 src:=replace(src, 'jsonb_agg(to_jsonb(p)) from page p', 'jsonb_agg(to_jsonb(p)-''focus_position'' order by focus_position) from page p');
 src:=replace(src, '''total'',(select count(*) from filtered)', '''focus_offset'',(select page_offset from position),''total'',(select count(*) from filtered)');
 if src=original or strpos(src,'_focus_case_id uuid)')=0 or strpos(src,'ranked as')=0 or strpos(src,'page_offset from position')=0 then
  raise exception 'Customer issue queue definition changed; review navigation migration';
 end if;
 execute src;
end $$;
revoke all on function public.list_customer_issues(text,text,text,int,int,text,text,uuid) from public,anon;
grant execute on function public.list_customer_issues(text,text,text,int,int,text,text,uuid) to authenticated;

-- Stable timezone-independent action signatures. Preserve current versions
-- and seed the equivalent key without treating deployment as a new action.
do $$
declare src text;
begin
 src:=pg_get_functiondef('public.reconcile_customer_issue_action(uuid)'::regprocedure);
 if strpos(src,'sig:=concat_ws(''|'',c.ebay_status,c.ebay_action,c.ebay_due_at::text);')=0 then
  raise exception 'Customer issue action signature changed; review migration';
 end if;
 execute replace(src,'sig:=concat_ws(''|'',c.ebay_status,c.ebay_action,c.ebay_due_at::text);',
  'sig:=concat_ws(''|'',c.ebay_status,coalesce(c.ebay_action,''''),coalesce(extract(epoch from c.ebay_due_at)::text,''''));');
end $$;
update public.ebay_return_cases
 set provider_action_key=concat_ws('|',ebay_status,coalesce(ebay_action,''),coalesce(extract(epoch from ebay_due_at)::text,''))
 where provider_action_key is not null;

-- Repair only the positively identified normalization mistake: the case has
-- no next steps or seller action and the supposed seller deadline came from
-- the general search deadline. Preserve the old value in its audit payload.
with repaired as (
 update public.ebay_return_cases c set ebay_due_at=null,provider_action_required=false,
  provider_action_key=concat_ws('|',c.ebay_status,'',''),
  raw_payload=jsonb_set(jsonb_set(c.raw_payload,'{ebayDetail,sellerResponseDue}','{}'),'{ebaySummary,sellerResponseDue}','{}') ||
   jsonb_build_object('notificationDeadlineRepair',jsonb_build_object('previous_due_at',c.ebay_due_at,'corrected_at',now(),'reason','general_case_deadline_not_seller_response'))
 where c.source_lane='case' and c.ebay_status='OPEN' and c.ebay_action is null and c.ebay_due_at is not null
  and c.raw_payload#>'{ebayDetail,nextSteps}'='[]'::jsonb
  and nullif(c.raw_payload#>>'{ebayDetail,sellerResponseDue,activityDue}','') is null
  and c.raw_payload#>'{ebayDetail,sellerResponseDue,respondByDate}'=c.raw_payload#>'{ebaySummary,respondByDate}'
 returning c.id
)
update public.task_notifications n set read_at=coalesce(n.read_at,now()),
 metadata=coalesce(n.metadata,'{}')||jsonb_build_object('superseded_reason','general_case_deadline_not_seller_response','superseded_at',now())
from repaired c where n.metadata->>'case_id'=c.id::text and n.notification_type in ('customer_issue_action','customer_issue_deadline')
 and (n.notification_type='customer_issue_deadline' or n.title like 'eBay response needed:%');

-- Reviewing a newer alert acknowledges the earlier alerts for that same
-- case, not other cases or staff task replies. Keep every audit record.
update public.task_notifications older set read_at=newer.read_at,
 metadata=coalesce(older.metadata,'{}')||jsonb_build_object('superseded_reason','newer_case_update_reviewed','superseded_by',newer.id)
from public.task_notifications newer
where older.recipient_user_id=newer.recipient_user_id and older.read_at is null and newer.read_at is not null
 and older.notification_type in ('customer_issue_action','customer_issue_deadline')
 and newer.notification_type in ('customer_issue_action','customer_issue_deadline')
 and older.metadata->>'case_id'=newer.metadata->>'case_id'
 and older.created_at<newer.created_at;

notify pgrst,'reload schema';
commit;
