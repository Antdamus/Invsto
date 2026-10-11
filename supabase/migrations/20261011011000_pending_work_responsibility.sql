begin;
set local lock_timeout='3s';
create or replace function public.list_pending_order_work(_line_ids uuid[]) returns setof jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory staff access required' using errcode='42501';end if;
 if coalesce(cardinality(_line_ids),0)>300 then raise exception 'Load at most 300 items';end if;
 return query select to_jsonb(b)||jsonb_build_object('line_ids',scope.ids,'active',public.pending_work_blocker_active(b),
 'assignee',case when b.kind='task' and review.needed then 'Review: '||coalesce(person.display_name,person.email,'Reviewer')
 when b.kind='task' then coalesce(person.display_name,person.email,nullif(t.data->>'assigned_to_email',''),'Unassigned task')
 else coalesce(person.display_name,person.email,b.created_by_email) end)
 from public.pending_order_work_blockers b
 cross join lateral(select array_agg(bl.order_line_id) ids from public.pending_order_work_blocker_lines bl where bl.blocker_id=b.id) scope
 left join lateral(select public.pending_work_task(b.task_source,b.task_id) data) t on b.kind='task'
 cross join lateral(select coalesce(t.data->>'status','') in ('completed_by_employee','waiting_on_admin','ready_for_admin_approval','pending_admin_review') needed) review
 left join lateral(select e.display_name,e.email from public.employees e where e.user_id=case
  when b.kind<>'task' then b.created_by
  when review.needed then public.task_workflow_reviewer(t.data)
  else (t.data->>'assigned_to_user_id')::uuid end limit 1) person on true
 where b.released_at is null and b.buyer_key in
 (select public.pending_work_buyer_key(l.order_id) from public.ebay_order_lines l where l.id=any(_line_ids))
 and exists(select 1 from public.ebay_order_lines l where l.id=any(scope.ids) and l.line_status in ('pending','partially_fulfilled'));
end $$;
revoke all on function public.list_pending_order_work(uuid[]) from public,anon;
grant execute on function public.list_pending_order_work(uuid[]) to authenticated;
notify pgrst,'reload schema';
commit;
