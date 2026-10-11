begin;
set local lock_timeout='3s';
set local statement_timeout='90s';

-- Explicit shipping blockers, independent of task creation, eBay imports and stock.
-- Scope is the current items, so an old hold cannot follow a buyer forever.
create table public.pending_order_work_blockers (
 id uuid primary key,
 buyer_key text not null,
 kind text not null check(kind in ('manual','task','cgl')),
 reason text not null check(length(reason) between 1 and 2000),
 task_source text check(task_source in ('team','order','return')),
 task_id uuid,
 certificate_id uuid references public.ebay_order_line_certificates(id) on delete restrict,
 released_at timestamptz,
 released_by uuid references auth.users(id),
 release_reason text,
 created_at timestamptz not null default now(),
 created_by uuid not null references auth.users(id),
 created_by_email text not null,
 revision bigint not null default 1,
 check((kind='task')=(task_source is not null and task_id is not null))
);
create table public.pending_order_work_blocker_lines (
 blocker_id uuid not null references public.pending_order_work_blockers(id) on delete restrict,
 order_line_id uuid not null references public.ebay_order_lines(id) on delete restrict,
 primary key(blocker_id,order_line_id)
);
create index pending_work_line_idx on public.pending_order_work_blocker_lines(order_line_id);
create index pending_work_buyer_idx on public.pending_order_work_blockers(buyer_key) where released_at is null;
create index pending_work_task_idx on public.pending_order_work_blockers(task_source,task_id) where kind='task' and released_at is null;
create table public.pending_order_work_events (
 id uuid primary key default gen_random_uuid(), blocker_id uuid not null references public.pending_order_work_blockers(id),
 action text not null, details jsonb not null default '{}', created_at timestamptz not null default now(),
 signed_by uuid references auth.users(id), signed_by_email text
);
alter table public.pending_order_work_blockers enable row level security;
alter table public.pending_order_work_blocker_lines enable row level security;
alter table public.pending_order_work_events enable row level security;
revoke all on public.pending_order_work_blockers,public.pending_order_work_blocker_lines,public.pending_order_work_events from public,anon,authenticated;
grant select on public.pending_order_work_blockers,public.pending_order_work_blocker_lines,public.pending_order_work_events to authenticated;
create policy pending_work_read on public.pending_order_work_blockers for select to authenticated using(public.can_manage_inventory());
create policy pending_work_lines_read on public.pending_order_work_blocker_lines for select to authenticated using(public.can_manage_inventory());
create policy pending_work_events_read on public.pending_order_work_events for select to authenticated using(public.can_manage_inventory());

create function public.pending_work_buyer_key(_order_id uuid) returns text
language sql stable security definer set search_path='' as $$
 select coalesce(nullif(lower(btrim(buyer_username)),''),'order:'||coalesce(nullif(order_number,''),id::text)) from public.ebay_orders where id=_order_id
$$;
create function public.pending_work_task(_source text,_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 case _source
 when 'order' then select to_jsonb(t) into result from public.ebay_order_tasks t where id=_id;
 when 'team' then select to_jsonb(t) into result from public.team_tasks t where id=_id;
 when 'return' then select to_jsonb(t) into result from public.ebay_return_tasks t where id=_id;
 else return null; end case;
 return result;
end $$;
create function public.pending_work_task_is_open(_task jsonb) returns boolean
language sql immutable set search_path='' as $$
 -- A missing/deleted task remains a hold until staff explicitly release it.
 select _task is null or (coalesce(_task->>'status','') not in
 ('resolved','cancelled','canceled','closed','approved_by_admin','approved_for_shipping','shipped_completed')
 and _task#>>'{metadata,history_removed_at}' is null)
$$;
create function public.pending_work_blocker_active(_blocker public.pending_order_work_blockers) returns boolean
language sql stable security definer set search_path='' as $$
 select _blocker.released_at is null and case _blocker.kind
 when 'task' then public.pending_work_task_is_open(public.pending_work_task(_blocker.task_source,_blocker.task_id))
 when 'cgl' then not exists(select 1 from public.ebay_order_line_certificates c where c.id=_blocker.certificate_id and c.voided_at is null)
 else true end
$$;

create function public.list_pending_order_work(_line_ids uuid[]) returns setof jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory staff access required' using errcode='42501';end if;
 if coalesce(cardinality(_line_ids),0)>300 then raise exception 'Load at most 300 items';end if;
 return query select to_jsonb(b)||jsonb_build_object('line_ids',scope.ids,'active',public.pending_work_blocker_active(b),
 'assignee',case when b.kind='task' then coalesce(nullif(t.data->>'assigned_to_email',''),'Task owner') else b.created_by_email end)
 from public.pending_order_work_blockers b
 cross join lateral(select array_agg(bl.order_line_id) ids from public.pending_order_work_blocker_lines bl where bl.blocker_id=b.id) scope
 left join lateral(select public.pending_work_task(b.task_source,b.task_id) data) t on b.kind='task'
 where b.released_at is null and b.buyer_key in
 (select public.pending_work_buyer_key(l.order_id) from public.ebay_order_lines l where l.id=any(_line_ids))
 and exists(select 1 from public.ebay_order_lines l where l.id=any(scope.ids) and l.line_status in ('pending','partially_fulfilled'));
end $$;

create function public.create_pending_order_work(_id uuid,_line_ids uuid[],_kind text,_reason text,
 _task_source text default null,_task_id uuid default null) returns uuid
language plpgsql security definer set search_path='' as $$
declare k text; n integer; t jsonb; buyer text; actor text; existing public.pending_order_work_blockers;
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory staff access required' using errcode='42501';end if;
 if _id is null or coalesce(cardinality(_line_ids),0) not between 1 and 500 or _kind not in ('manual','task','cgl')
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
 if _kind='cgl' then
  if n<>1 or not exists(select 1 from public.order_line_watch_flags where order_line_id=_line_ids[1] and is_watch)
  then raise exception 'Mark this item Watch before setting Pending CGL';end if;
  select b.* into existing from public.pending_order_work_blockers b join public.pending_order_work_blocker_lines bl on bl.blocker_id=b.id
  where bl.order_line_id=_line_ids[1] and b.kind='cgl' and b.released_at is null for update of b;
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

create function public.release_pending_order_work(_id uuid,_expected_revision bigint,_reason text) returns void
language plpgsql security definer set search_path='' as $$
declare b public.pending_order_work_blockers;
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory staff access required' using errcode='42501';end if;
 if nullif(btrim(_reason),'') is null or length(_reason)>2000 then raise exception 'Enter why this no longer blocks shipping';end if;
 select * into b from public.pending_order_work_blockers where id=_id for update;
 if not found then raise exception 'Waiting entry not found';end if;
 if b.released_at is not null then return;end if;
 if b.revision is distinct from _expected_revision then raise exception 'This waiting entry changed. Refresh and try again.' using errcode='40001';end if;
 if b.kind='cgl' then raise exception 'Attach and confirm the certificate, or remove the CGL requirement with a correction reason';end if;
 update public.pending_order_work_blockers set released_at=now(),released_by=auth.uid(),release_reason=btrim(_reason),revision=revision+1 where id=_id;
 insert into public.pending_order_work_events(blocker_id,action,details,signed_by,signed_by_email)
 values(_id,'released',jsonb_build_object('reason',btrim(_reason)),auth.uid(),(select email from auth.users where id=auth.uid()));
end $$;

create function public.confirm_pending_cgl(_id uuid,_expected_revision bigint,_certificate_id uuid default null,_correction_reason text default null) returns void
language plpgsql security definer set search_path='' as $$
declare b public.pending_order_work_blockers;
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory staff access required' using errcode='42501';end if;
 select * into b from public.pending_order_work_blockers where id=_id for update;
 if not found or b.kind<>'cgl' or b.released_at is not null then raise exception 'Active CGL requirement not found';end if;
 if b.revision is distinct from _expected_revision then raise exception 'The CGL requirement changed. Refresh and try again.' using errcode='40001';end if;
 if _certificate_id is not null then
  perform 1 from public.ebay_order_line_certificates c join public.pending_order_work_blocker_lines bl on bl.order_line_id=c.order_line_id
   where c.id=_certificate_id and bl.blocker_id=b.id and c.voided_at is null for share of c;
  if not found then raise exception 'Choose a saved, valid certificate for this watch';end if;
  update public.pending_order_work_blockers set certificate_id=_certificate_id,revision=revision+1 where id=b.id;
 else
  if nullif(btrim(_correction_reason),'') is null or length(_correction_reason)>2000 then raise exception 'Explain why CGL is not required for this watch';end if;
  update public.pending_order_work_blockers set released_at=now(),released_by=auth.uid(),release_reason=btrim(_correction_reason),revision=revision+1 where id=b.id;
 end if;
 insert into public.pending_order_work_events(blocker_id,action,details,signed_by,signed_by_email)
 values(b.id,case when _certificate_id is null then 'requirement_corrected' else 'certificate_confirmed' end,
 jsonb_build_object('certificate_id',_certificate_id,'reason',_correction_reason),auth.uid(),(select email from auth.users where id=auth.uid()));
end $$;

-- Re-evaluate current task/certificate state on every completion, including old clients.
create function public.assert_pending_work_clear(_order_ids uuid[]) returns void
language plpgsql security definer set search_path='' as $$
declare b public.pending_order_work_blockers;
begin
 select x.* into b from public.pending_order_work_blockers x
 where x.buyer_key in (select public.pending_work_buyer_key(id) from public.ebay_orders where id=any(_order_ids))
 and x.released_at is null and public.pending_work_blocker_active(x)
 and exists(select 1 from public.pending_order_work_blocker_lines bl join public.ebay_order_lines l on l.id=bl.order_line_id
  where bl.blocker_id=x.id and l.line_status in ('pending','partially_fulfilled')) limit 1;
 if found then raise exception 'Package is waiting: %. Resolve its blocker before completing this buyer''s items.',b.reason using errcode='23514';end if;
end $$;
create function public.guard_pending_work_completion() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is not null then
  if tg_table_name='ebay_order_lines' then
   if (new.line_status='fulfilled' and old.line_status is distinct from new.line_status) or new.fulfilled_quantity>coalesce(old.fulfilled_quantity,0)
   then perform public.assert_pending_work_clear(array[new.order_id]);end if;
  elsif new.status='fulfilled' and old.status is distinct from new.status then perform public.assert_pending_work_clear(array[new.id]);end if;
 end if;
 return new;
end $$;
create trigger aab_pending_work_completion before update of line_status,fulfilled_quantity on public.ebay_order_lines for each row execute function public.guard_pending_work_completion();
create trigger pending_work_order_completion before update of status on public.ebay_orders for each row execute function public.guard_pending_work_completion();
create function public.guard_packaging_cgl_requirement() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 -- A certificate corrected after checkout must also stop dispatch of that package.
 if new.status in ('ready','dispatched') and (tg_op='INSERT' or new.status is distinct from old.status)
 and exists(select 1 from public.pending_order_work_blockers b
 join public.pending_order_work_blocker_lines bl on bl.blocker_id=b.id
 join public.ebay_order_lines l on l.id=bl.order_line_id
 where l.order_id=any(new.order_ids) and b.kind='cgl' and public.pending_work_blocker_active(b))
 then raise exception 'Pending CGL: a required certificate is missing or marked incorrect. Confirm the correct certificate before dispatch.' using errcode='23514';end if;
 return new;
end $$;
create trigger packaging_cgl_requirement before insert or update of status on public.packaging_shipments for each row execute function public.guard_packaging_cgl_requirement();
create function public.guard_pending_watch_requirement() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if not new.is_watch and exists(select 1 from public.pending_order_work_blockers b join public.pending_order_work_blocker_lines bl on bl.blocker_id=b.id
 where bl.order_line_id=new.order_line_id and b.kind='cgl' and b.released_at is null)
 then raise exception 'Remove the CGL requirement with a correction reason before removing Watch';end if;
 return new;
end $$;
create trigger pending_watch_requirement before update of is_watch on public.order_line_watch_flags for each row execute function public.guard_pending_watch_requirement();

create function public.notify_pending_work_change() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_table_name in ('team_tasks','ebay_order_tasks','ebay_return_tasks') and not exists
 (select 1 from public.pending_order_work_blockers where task_id=(to_jsonb(new)->>'id')::uuid and task_source=tg_argv[0] and released_at is null) then return new;end if;
 begin perform realtime.send(jsonb_build_object('kind','work_blocker'),'changed','pending-orders:updates',true);
 exception when others then raise warning 'Pending work notification unavailable: %',sqlstate;end;
 return new;
end $$;
create trigger pending_work_change after insert or update on public.pending_order_work_blockers for each row execute function public.notify_pending_work_change();
create trigger pending_work_scope_change after insert on public.pending_order_work_blocker_lines for each row execute function public.notify_pending_work_change();
create trigger pending_work_team_change after update of status,assigned_to_user_id,metadata on public.team_tasks for each row execute function public.notify_pending_work_change('team');
create trigger pending_work_order_change after update of status,assigned_to_user_id,metadata on public.ebay_order_tasks for each row execute function public.notify_pending_work_change('order');
create trigger pending_work_return_change after update of status,assigned_to_user_id,metadata on public.ebay_return_tasks for each row execute function public.notify_pending_work_change('return');
create trigger pending_work_certificate_change after insert or update of voided_at on public.ebay_order_line_certificates for each row execute function public.notify_pending_work_change();

revoke all on function public.pending_work_buyer_key(uuid),public.pending_work_task(text,uuid),public.pending_work_task_is_open(jsonb),public.pending_work_blocker_active(public.pending_order_work_blockers),public.assert_pending_work_clear(uuid[]),public.guard_pending_work_completion(),public.guard_packaging_cgl_requirement(),public.guard_pending_watch_requirement(),public.notify_pending_work_change() from public,anon,authenticated;
revoke all on function public.list_pending_order_work(uuid[]),public.create_pending_order_work(uuid,uuid[],text,text,text,uuid),public.release_pending_order_work(uuid,bigint,text),public.confirm_pending_cgl(uuid,bigint,uuid,text) from public,anon;
grant execute on function public.list_pending_order_work(uuid[]),public.create_pending_order_work(uuid,uuid[],text,text,text,uuid),public.release_pending_order_work(uuid,bigint,text),public.confirm_pending_cgl(uuid,bigint,uuid,text) to authenticated;
notify pgrst,'reload schema';
commit;
