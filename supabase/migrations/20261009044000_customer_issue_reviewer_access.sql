begin;
-- The shared reviewer resolver is private. Expose only an existing return
-- task's reviewer to staff already allowed to read customer issues.
create function public.customer_issue_task_reviewer(_task_id uuid) returns uuid
language plpgsql stable security definer set search_path='' as $$
declare task jsonb;
begin
 if auth.uid() is null or not public.can_access_post_order_issues() then return null;end if;
 select to_jsonb(t) into task from public.ebay_return_tasks t where t.id=_task_id;
 if task is null then return null;end if;
 return public.task_workflow_reviewer(task);
end $$;
revoke all on function public.customer_issue_task_reviewer(uuid) from public,anon;
grant execute on function public.customer_issue_task_reviewer(uuid) to authenticated;
do $$
declare definition text;
begin
 select pg_get_functiondef('public.list_customer_issues(text,text,text,integer,integer)'::regprocedure) into definition;
 if strpos(definition,'public.task_workflow_reviewer(to_jsonb(t))')=0 then raise exception 'Customer issue queue signature changed';end if;
 execute replace(definition,'public.task_workflow_reviewer(to_jsonb(t))','public.customer_issue_task_reviewer(t.id)');
end $$;
commit;
