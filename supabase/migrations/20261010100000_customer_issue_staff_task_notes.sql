begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

-- Read the actual case tasks, not duplicated notes. Both task and evidence RLS
-- remain in force, and the lookup is batched for the visible case cards.
create or replace function public.customer_issue_task_notes(_case_ids uuid[],_limit int default 3,_offset int default 0)
returns jsonb language sql stable security invoker set search_path='' as $$
 with visible as materialized (
  select t.* from public.ebay_return_tasks t
  join public.ebay_return_cases c on c.id=t.return_case_id
  where c.id=any(_case_ids[1:100]) and (select auth.uid()) is not null
   and (select public.can_access_post_order_issues())
   -- Only staff-created work belongs in the compact notes feed. Imported tasks
   -- may carry the importing user's identity; that does not make them authored.
   and (t.created_by is not null or nullif(btrim(t.created_by_email),'') is not null)
   and lower(coalesce(t.metadata->>'source','')) not in ('ebay_return_api','ebay_post_order_api','ebay_return_extension','customer_issue_action')
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

