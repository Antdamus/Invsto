begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

-- Read-only inbox. The caller cannot choose another employee's recipient ID.
-- Explicit task assignments/replies remain Tasks even when the work is a return.
create function public.notification_inbox(_category text default 'all', _view text default 'unread', _limit integer default 30)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb; recipient uuid:=auth.uid(); page_limit integer:=greatest(coalesce(_limit,30),1);
begin
 if recipient is null then raise exception 'Sign in to see your updates'; end if;
 if _category is null or _category not in ('all','tasks','buyers','returns','system') or _view is null or _view not in ('unread','recent') then
  raise exception 'Unknown notification filter';
 end if;
 with notices as materialized (
  select n.id,n.recipient_user_id,n.source,n.task_id,n.notification_type,n.title,n.body,n.actor_email,n.priority,n.read_at,n.created_at,n.metadata,
   case when n.notification_type='customer_issue_sync' then 'system'
    when n.notification_type in ('customer_issue_action','customer_issue_deadline') then
     case when coalesce(c.issue_kind,c.source_lane)='return' then 'returns' else 'buyers' end
    else 'tasks' end category
  from public.task_notifications n
  left join public.ebay_return_tasks t on n.source='return' and n.notification_type in ('customer_issue_action','customer_issue_deadline') and t.id=n.task_id
  left join public.ebay_return_cases c on c.id=coalesce(
   case when n.metadata->>'case_id' ~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' then (n.metadata->>'case_id')::uuid end,t.return_case_id)
   and n.notification_type in ('customer_issue_action','customer_issue_deadline')
  where n.recipient_user_id=recipient and (_view='recent' or n.read_at is null)
 ), visible as (select * from notices where (_category='all' or category=_category) and (_view='recent' or read_at is null))
 select jsonb_build_object(
  'unread_count',(select count(*) from notices where read_at is null),
  'counts',(select jsonb_build_object('all',count(*),'tasks',count(*) filter(where category='tasks'),'buyers',count(*) filter(where category='buyers'),
    'returns',count(*) filter(where category='returns'),'system',count(*) filter(where category='system')) from notices where read_at is null),
  'total',(select count(*) from visible),
  'entries',coalesce((select jsonb_agg(to_jsonb(p) order by created_at desc,id desc) from (select * from visible order by created_at desc,id desc limit page_limit)p),'[]'::jsonb),
  'unread',coalesce((select jsonb_agg(to_jsonb(p) order by created_at desc,id desc) from (select * from notices where read_at is null order by created_at desc,id desc limit 30)p),'[]'::jsonb)
 ) into result;
 return result;
end $$;
revoke all on function public.notification_inbox(text,text,integer) from public,anon;
grant execute on function public.notification_inbox(text,text,integer) to authenticated;
commit;
