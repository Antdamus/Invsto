begin;
set local lock_timeout='3s';
set local statement_timeout='90s';

-- A missing watch is an explicit, line-scoped hold. No tasks or inventory changes.
alter table public.pending_order_work_blockers drop constraint pending_order_work_blockers_kind_check;
alter table public.pending_order_work_blockers add constraint pending_order_work_blockers_kind_check
 check(kind in ('manual','task','cgl','watch_missing'));

create or replace function public.create_pending_order_work(_id uuid,_line_ids uuid[],_kind text,_reason text,
 _task_source text default null,_task_id uuid default null) returns uuid
language plpgsql security definer set search_path='' as $$
declare k text; n integer; t jsonb; buyer text; actor text; existing public.pending_order_work_blockers;
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory staff access required' using errcode='42501';end if;
 if _id is null or coalesce(cardinality(_line_ids),0) not between 1 and 500 or _kind not in ('manual','task','cgl','watch_missing')
 or nullif(btrim(_reason),'') is null or length(_reason)>2000 then raise exception 'Select items and enter a waiting reason' using errcode='22023';end if;
 -- Serializes create/retry for this request. No automatic tasks are generated.
 perform pg_advisory_xact_lock(hashtextextended(_id::text,0));
 select * into existing from public.pending_order_work_blockers where id=_id;
 if found then
  if existing.created_by<>auth.uid() then raise exception 'Request belongs to another employee' using errcode='42501';end if;
  return existing.id;
 end if;
 perform 1 from public.ebay_order_lines where id=any(_line_ids) order by id for update;
 select count(*),min(public.pending_work_buyer_key(order_id)) into n,k from public.ebay_order_lines
 where id=any(_line_ids) and line_status in ('pending','partially_fulfilled');
 if n<>(select count(distinct x) from unnest(_line_ids) x) or n=0
 or exists(select 1 from public.ebay_order_lines where id=any(_line_ids) and public.pending_work_buyer_key(order_id)<>k)
 then raise exception 'These items changed or belong to different buyers. Refresh the queue.' using errcode='40001';end if;
 if _kind in ('cgl','watch_missing') then
  if n<>1 or not exists(select 1 from public.order_line_watch_flags where order_line_id=_line_ids[1] and is_watch)
  then raise exception 'Mark this item Watch before setting Pending CGL or Watch missing';end if;
  select b.* into existing from public.pending_order_work_blockers b join public.pending_order_work_blocker_lines bl on bl.blocker_id=b.id
  where bl.order_line_id=_line_ids[1] and b.kind=_kind and b.released_at is null for update of b;
  if found then return existing.id;end if;
 end if;
 if _kind='task' then
  t:=public.pending_work_task(_task_source,_task_id);
  if t is null or not public.pending_work_task_is_open(t) then raise exception 'Choose an open task';end if;
  if _task_source='team' and not coalesce((public.is_admin() or (t->>'created_by')::uuid=auth.uid()
   or (t->>'assigned_to_user_id')::uuid=auth.uid() or exists(select 1 from public.task_followers where source='team' and task_id=_task_id and user_id=auth.uid())),false)
  then raise exception 'Task access required' using errcode='42501';end if;
  if _task_source='order' then buyer:=public.pending_work_buyer_key((t->>'order_id')::uuid);
  elsif _task_source='return' then
   if not coalesce(public.can_access_post_order_issues(),false) or not public.customer_issue_is_employee_task(t) then raise exception 'Choose a staff-created case task' using errcode='42501';end if;
   select lower(btrim(buyer_username)) into buyer from public.ebay_return_cases where id=(t->>'return_case_id')::uuid;
  else
   buyer:=lower(btrim(coalesce(nullif(t#>>'{metadata,buyer_username}',''),nullif(t#>>'{metadata,buyerUsername}',''))));
   if nullif(buyer,'') is null and t#>>'{metadata,conversation_id}' ~* '^[0-9a-f-]{36}$' then
    select lower(btrim(other_party_username)) into buyer from public.ebay_conversations where id=(t#>>'{metadata,conversation_id}')::uuid;
    if nullif(buyer,'') is null then
     select min(lower(btrim(coalesce(nullif(buyer_username,''),matched_value)))) into buyer from public.ebay_conversation_links
     where conversation_id=(t#>>'{metadata,conversation_id}')::uuid and status='confirmed' and link_type='buyer_username'
     having count(distinct lower(btrim(coalesce(nullif(buyer_username,''),matched_value))))=1;
    end if;
   end if;
  end if;
  if buyer is distinct from k then raise exception 'This task belongs to a different customer';end if;
 elsif _task_source is not null or _task_id is not null then raise exception 'Only task holds can link a task';end if;
 select coalesce(email,'Staff') into actor from auth.users where id=auth.uid();
 insert into public.pending_order_work_blockers(id,buyer_key,kind,reason,task_source,task_id,created_by,created_by_email)
 values(_id,k,_kind,btrim(_reason),_task_source,_task_id,auth.uid(),coalesce(actor,'Staff'));
 insert into public.pending_order_work_blocker_lines select _id,x from (select distinct unnest(_line_ids) x) ids;
 insert into public.pending_order_work_events(blocker_id,action,signed_by,signed_by_email) values(_id,'waiting',auth.uid(),actor);
 return _id;
end $$;

create or replace function public.guard_pending_watch_requirement() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if not new.is_watch and exists(select 1 from public.pending_order_work_blockers b join public.pending_order_work_blocker_lines bl on bl.blocker_id=b.id
 where bl.order_line_id=new.order_line_id and b.kind in ('cgl','watch_missing') and b.released_at is null)
 then raise exception 'Resolve Watch missing or remove the CGL requirement with a correction reason before removing Watch';end if;
 return new;
end $$;

create or replace function public.guard_packaging_cgl_requirement() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.status in ('ready','dispatched') and (tg_op='INSERT' or new.status is distinct from old.status) then
  if exists(select 1 from public.pending_order_work_blockers b
   join public.pending_order_work_blocker_lines bl on bl.blocker_id=b.id
   join public.ebay_order_lines l on l.id=bl.order_line_id
   where l.order_id=any(new.order_ids) and b.kind='watch_missing' and public.pending_work_blocker_active(b))
  then raise exception 'Watch missing: locate and check the watch before dispatch.' using errcode='23514';end if;
  if exists(select 1 from public.pending_order_work_blockers b
   join public.pending_order_work_blocker_lines bl on bl.blocker_id=b.id
   join public.ebay_order_lines l on l.id=bl.order_line_id
   where l.order_id=any(new.order_ids) and b.kind='cgl' and public.pending_work_blocker_active(b))
  then raise exception 'Pending CGL: a required certificate is missing or marked incorrect. Confirm the correct certificate before dispatch.' using errcode='23514';end if;
 end if;
 return new;
end $$;
notify pgrst,'reload schema';
commit;
