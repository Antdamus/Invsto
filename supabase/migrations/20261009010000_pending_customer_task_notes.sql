begin;
set local lock_timeout = '2s';
set local statement_timeout = '60s';

-- Exact customer identifiers only. These indexes also keep a queue refresh from
-- scanning completed task history. Existing table RLS remains authoritative.
create index if not exists team_tasks_customer_notes_idx on public.team_tasks
 ((lower(btrim(coalesce(nullif(metadata->>'buyer_username',''),metadata->>'buyerUsername')))))
 where status not in ('resolved','cancelled','canceled','closed','approved_by_admin','approved_for_shipping','shipped_completed');
create index if not exists ebay_orders_customer_notes_idx on public.ebay_orders ((lower(btrim(buyer_username))));
create index if not exists ebay_return_cases_customer_notes_idx on public.ebay_return_cases ((lower(btrim(buyer_username))));

create function public.list_pending_customer_task_notes(_buyers text[])
returns setof jsonb language plpgsql stable security invoker set search_path='' as $$
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then
  raise exception 'Inventory staff access required' using errcode='42501';
 end if;
 if cardinality(_buyers)>75 then
  raise exception 'Request at most 75 customers at a time' using errcode='22023';
 end if;
 return query
 with buyers as (
  select distinct lower(btrim(buyer)) buyer from unnest(_buyers) buyer where nullif(btrim(buyer),'') is not null
 ), matched as (
  select 'team'::text source,to_jsonb(t) task,
   identity.buyer
  from public.team_tasks t
  left join public.ebay_conversations c on c.id=case
   when t.metadata->>'conversation_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   then (t.metadata->>'conversation_id')::uuid end
  left join lateral (
   -- Legacy conversations may store their customer only in confirmed links.
   -- Conflicting identities are deliberately not guessed from a task title.
   select min(lower(btrim(coalesce(nullif(l.buyer_username,''),l.matched_value)))) buyer
   from public.ebay_conversation_links l where l.conversation_id=c.id
    and l.link_type='buyer_username' and l.status='confirmed'
    and nullif(btrim(coalesce(nullif(l.buyer_username,''),l.matched_value)),'') is not null
   having count(distinct lower(btrim(coalesce(nullif(l.buyer_username,''),l.matched_value))))=1
  ) verified on nullif(btrim(c.other_party_username),'') is null
  cross join lateral (select lower(btrim(coalesce(nullif(btrim(t.metadata->>'buyer_username'),''),
   nullif(btrim(t.metadata->>'buyerUsername'),''),nullif(btrim(c.other_party_username),''),verified.buyer))) buyer) identity
  where identity.buyer in (select buyer from buyers)
   and t.status not in ('resolved','cancelled','canceled','closed','approved_by_admin','approved_for_shipping','shipped_completed')
  union all
  select 'order',to_jsonb(t),lower(btrim(o.buyer_username))
  from public.ebay_order_tasks t join public.ebay_orders o on o.id=t.order_id
  where lower(btrim(o.buyer_username)) in (select buyer from buyers)
  union all
  select 'return',to_jsonb(t),lower(btrim(c.buyer_username))
  from public.ebay_return_tasks t join public.ebay_return_cases c on c.id=t.return_case_id
  where lower(btrim(c.buyer_username)) in (select buyer from buyers)
 ), active as materialized (
  select * from matched where task->>'status' not in
   ('resolved','cancelled','canceled','closed','approved_by_admin','approved_for_shipping','shipped_completed')
   and task#>>'{metadata,history_removed_at}' is null
   and lower(coalesce(task#>>'{metadata,hidden_from_task_board}','false')) not in ('true','1','yes')
   and task#>>'{metadata,assignment_cancelled_at}' is null
   and task#>>'{metadata,assignment_canceled_at}' is null
   and coalesce(task#>>'{metadata,source}','') <> 'pending_order_line_note'
   and coalesce(task->>'title','') !~* '^Video receipt screenshot (captured|uploaded)'
   and coalesce(task->>'question','') !~* '^Video receipt screenshot (captured|uploaded)'
 )
 select jsonb_build_object('source',a.source,'buyer_username',a.buyer,
  'id',task->'id','order_id',task->'order_id','order_line_ids',task->'order_line_ids',
  'title',task->>'title','question',coalesce(nullif(task->>'description',''),nullif(task->>'question',''),task->>'title'),
  'status',task->>'status','created_at',task->'created_at','created_by_email',task->>'created_by_email',
  'assigned_to_user_id',task->'assigned_to_user_id','assigned_to_employee_id',task->'assigned_to_employee_id',
  'assigned_to_email',task->>'assigned_to_email','assignee_name',coalesce(person.display_name,person.email,task->>'assigned_to_email'),
  'latest_note',task->>'latest_note',
  'attachment_count',(select count(distinct concat(photo->>'bucket',':',photo->>'path')) from (
   select e.photo_attachments photos from public.team_task_events e where a.source='team' and e.task_id=(task->>'id')::uuid
   union all select e.photo_attachments from public.ebay_order_task_events e where a.source='order' and e.task_id=(task->>'id')::uuid
   union all select e.photo_attachments from public.ebay_return_task_events e where a.source='return' and e.task_id=(task->>'id')::uuid
  ) evidence cross join lateral jsonb_array_elements(case when jsonb_typeof(photos)='array' then photos else '[]'::jsonb end) photo
   where nullif(photo->>'path','') is not null)
 ) from active a left join lateral (
  select e.display_name,e.email from public.employees e where e.user_id=(task->>'assigned_to_user_id')::uuid limit 1
 ) person on true order by task->>'created_at' desc,a.source,task->>'id';
end;
$$;
revoke all on function public.list_pending_customer_task_notes(text[]) from public,anon;
grant execute on function public.list_pending_customer_task_notes(text[]) to authenticated;
comment on function public.list_pending_customer_task_notes(text[]) is
 'Read-only, exact-username open task notes from orders, independent/customer-service tasks and returns. Existing task and event RLS applies.';
notify pgrst,'reload schema';
commit;
