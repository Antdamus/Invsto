begin;
set local lock_timeout = '3s';
set local statement_timeout = '60s';

-- Current decisions are private writes; the ordinary task event trail retains
-- every signed decision, including an admin changing a certification to a deferral.
create table public.buyer_promise_order_signoffs (
 task_id uuid not null references public.team_tasks(id),
 order_id uuid not null references public.ebay_orders(id),
 decision text not null check(decision in ('certify','defer')),
 instruction_version text not null,
 instructions jsonb not null,
 signature text not null,
 reason text not null,
 signed_by uuid not null,
 signed_by_email text not null,
 signed_at timestamptz not null default now(),
 consumed_at timestamptz,
 primary key(task_id,order_id)
);
create unique index buyer_promise_one_certified_order on public.buyer_promise_order_signoffs(task_id) where decision='certify';
create index team_tasks_buyer_promise_lookup on public.team_tasks((metadata->>'buyer_username')) where metadata->>'source'='buyer_followup';
alter table public.buyer_promise_order_signoffs enable row level security;
create policy buyer_promise_signoffs_read on public.buyer_promise_order_signoffs for select to authenticated
 using(auth.uid() is not null and public.can_manage_inventory());
grant select on public.buyer_promise_order_signoffs to authenticated;
revoke insert,update,delete on public.buyer_promise_order_signoffs from public,anon,authenticated;

create function public.buyer_promise_version(t public.team_tasks) returns text
language sql immutable set search_path='' as $$select md5(jsonb_build_array(t.title,t.description)::text)$$;

create function public.list_buyer_promise_requirements(_order_ids uuid[]) returns setof jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then raise exception 'Active staff access required' using errcode='42501';end if;
 if coalesce(cardinality(_order_ids),0)>75 then raise exception 'Choose at most 75 orders';end if;
 return query select jsonb_build_object('task_id',t.id,'order_id',o.id,'order_number',o.order_number,
 'buyer_username',o.buyer_username,'title',t.title,'instructions',t.description,'version',public.buyer_promise_version(t),
 'decision',case when s.instruction_version=public.buyer_promise_version(t) then s.decision end,
 'signed_by_email',s.signed_by_email,'signature',s.signature,'signed_at',s.signed_at,'reason',s.reason,
 'can_defer',coalesce(public.is_admin(),false),'consumed_at',s.consumed_at)
 from public.ebay_orders o join public.team_tasks t on lower(btrim(o.buyer_username))=t.metadata->>'buyer_username'
 left join public.buyer_promise_order_signoffs s on s.task_id=t.id and s.order_id=o.id
 where o.id=any(_order_ids) and t.metadata->>'source'='buyer_followup'
 and (t.status not in ('resolved','cancelled') or s.consumed_at is not null)
 order by o.order_number,t.created_at,t.id;
end $$;

create function public.sign_buyer_promise(_task_id uuid,_order_id uuid,_decision text,_signature text,_reason text,_version text)
returns void language plpgsql security definer set search_path='' as $$
declare t public.team_tasks; o public.ebay_orders; actor public.employees; existing public.buyer_promise_order_signoffs;
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then raise exception 'Active staff access required' using errcode='42501';end if;
 select * into actor from public.employees where user_id=auth.uid() and active is true limit 1;
 if not found then raise exception 'Active employee not found' using errcode='42501';end if;
 if _decision is null or _decision not in ('certify','defer') then raise exception 'Choose certification or admin permission';end if;
 if _decision='defer' and not coalesce(public.is_admin(),false) then raise exception 'Only an admin can defer a customer promise' using errcode='42501';end if;
 if length(btrim(coalesce(_signature,'')))<2 or length(_signature)>150 then raise exception 'Type your name to sign';end if;
 if nullif(btrim(_reason),'') is null or length(_reason)>2000 then raise exception 'Describe what was fulfilled, or why the promise is deferred';end if;
 select * into o from public.ebay_orders where id=_order_id;
 if not found then raise exception 'Order not found';end if;
 perform pg_advisory_xact_lock(hashtextextended('buyer-promise:' || lower(btrim(o.buyer_username)),0));
 select * into t from public.team_tasks where id=_task_id for update;
 if not found or t.metadata->>'source' is distinct from 'buyer_followup'
 or t.metadata->>'buyer_username' is distinct from lower(btrim(o.buyer_username)) then raise exception 'This promise does not belong to this customer';end if;
 if t.status in ('resolved','cancelled') then raise exception 'This promise is already closed. Refresh the order.';end if;
 if public.buyer_promise_version(t) is distinct from _version then raise exception 'The promise changed. Refresh and review the instructions before signing.' using errcode='40001';end if;
 if not exists(select 1 from public.ebay_order_lines where order_id=o.id and line_status in ('pending','partially_fulfilled')) then raise exception 'This order is no longer pending';end if;
 select * into existing from public.buyer_promise_order_signoffs where task_id=t.id and order_id=o.id;
 if existing.consumed_at is not null then raise exception 'This promise was already fulfilled';end if;
 -- A signed statement cannot be replaced by another employee.
 if existing.task_id is not null then
  if existing.decision=_decision and existing.instruction_version=_version and existing.signed_by=auth.uid()
   and existing.signature=btrim(_signature) and existing.reason=btrim(_reason) then return;end if;
  if not coalesce(public.is_admin(),false) then raise exception 'An admin must change an existing signed decision' using errcode='42501';end if;
 end if;
 if _decision='certify' and exists(select 1 from public.buyer_promise_order_signoffs where task_id=t.id and decision='certify' and order_id<>o.id)
 then raise exception 'This promise is signed for another order. An admin must defer it on that order before moving it here.';end if;
 insert into public.buyer_promise_order_signoffs(task_id,order_id,decision,instruction_version,instructions,signature,reason,signed_by,signed_by_email)
 values(t.id,o.id,_decision,_version,jsonb_build_object('title',t.title,'description',t.description),btrim(_signature),btrim(_reason),auth.uid(),coalesce(actor.email,''))
 on conflict(task_id,order_id) do update set decision=excluded.decision,instruction_version=excluded.instruction_version,
 instructions=excluded.instructions,signature=excluded.signature,reason=excluded.reason,signed_by=excluded.signed_by,signed_by_email=excluded.signed_by_email,signed_at=now();
 insert into public.team_task_events(task_id,action,old_status,new_status,notes,signed_by,signed_by_email,payload)
 values(t.id,'commented',t.status,t.status,case when _decision='certify' then 'Certified fulfilled for order ' else 'Admin permission to defer on order ' end || coalesce(o.order_number,o.id::text) || ': ' || btrim(_reason),auth.uid(),actor.email,
 jsonb_build_object('source','buyer_promise_signoff','order_id',o.id,'decision',_decision,'signature',btrim(_signature),'instructions',jsonb_build_object('title',t.title,'description',t.description),'version',_version));
end $$;

create function public.assert_buyer_promises_clear(_order_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare buyer text; title text;
begin
 select lower(btrim(buyer_username)) into buyer from public.ebay_orders where id=_order_id;
 if nullif(buyer,'') is null then return;end if;
 perform pg_advisory_xact_lock(hashtextextended('buyer-promise:' || buyer,0));
 select t.title into title from public.team_tasks t
 where t.metadata->>'source'='buyer_followup' and t.metadata->>'buyer_username'=buyer and t.status not in ('resolved','cancelled')
 and not exists(select 1 from public.buyer_promise_order_signoffs s where s.task_id=t.id and s.order_id=_order_id
 and s.instruction_version=public.buyer_promise_version(t)) limit 1;
 if found then raise exception 'Customer promise requires signed certification or admin permission: %',title using errcode='23514';end if;
end $$;

create function public.guard_buyer_promise_fulfillment() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is not null then
  if tg_table_name='ebay_order_lines' then
   if (new.line_status='fulfilled' and old.line_status is distinct from new.line_status) or new.fulfilled_quantity>coalesce(old.fulfilled_quantity,0)
   then perform public.assert_buyer_promises_clear(new.order_id);end if;
  elsif new.status='fulfilled' and old.status is distinct from new.status then perform public.assert_buyer_promises_clear(new.id);end if;
 end if;
 return new;
end $$;
create trigger aaa_buyer_promise_completion before update of line_status,fulfilled_quantity on public.ebay_order_lines for each row execute function public.guard_buyer_promise_fulfillment();
create trigger aaa_buyer_promise_order_completion before update of status on public.ebay_orders for each row execute function public.guard_buyer_promise_fulfillment();

-- Consume the promise only when the order actually finishes, in the same
-- transaction as checkout. Failed or partial checkout keeps the promise open.
create function public.finish_buyer_promises() returns trigger
language plpgsql security definer set search_path='' as $$
declare s public.buyer_promise_order_signoffs; t public.team_tasks;
begin
 if new.fulfilled_quantity<old.fulfilled_quantity or (old.line_status='fulfilled' and new.line_status in ('pending','partially_fulfilled')) then
  for s in select * from public.buyer_promise_order_signoffs where order_id=new.order_id and decision='certify' loop
   delete from public.buyer_promise_order_signoffs where task_id=s.task_id and order_id=s.order_id;
   update public.team_tasks set status='assigned',resolved_at=null,resolved_by=null,resolved_by_email=null,resolution_notes=null,
    metadata=metadata-'task_workflow' where id=s.task_id and status='resolved';
   insert into public.team_task_events(task_id,action,notes,signed_by,signed_by_email,payload)
   values(s.task_id,'commented','Order fulfillment was reversed. The customer promise requires a new signature.',auth.uid(),
    (select email from public.employees where user_id=auth.uid() limit 1),jsonb_build_object('source','buyer_promise_reopened','order_id',s.order_id,'previous_signature',s.signature));
  end loop;
  return new;
 end if;
 if new.line_status<>'fulfilled' or (old.line_status=new.line_status and old.fulfilled_quantity=new.fulfilled_quantity) then return new;end if;
 if exists(select 1 from public.ebay_order_lines where order_id=new.order_id and line_status not in ('fulfilled','cancelled','skipped')) then return new;end if;
 for s in select * from public.buyer_promise_order_signoffs where order_id=new.order_id and decision='certify' and consumed_at is null loop
  select * into t from public.team_tasks where id=s.task_id for update;
  if t.status='cancelled' or public.buyer_promise_version(t)<>s.instruction_version then continue;end if;
  update public.buyer_promise_order_signoffs set consumed_at=now() where task_id=s.task_id and order_id=s.order_id;
  update public.team_tasks set status='resolved',resolved_at=now(),resolved_by=s.signed_by,resolved_by_email=s.signed_by_email,
   resolution_notes='Signed fulfillment on order '||s.order_id::text||': '||s.reason,
   metadata=metadata||jsonb_build_object('task_workflow',coalesce(metadata->'task_workflow','{}')||jsonb_build_object('accepted_at',now(),'accepted_by',s.signed_by)) where id=t.id;
  insert into public.team_task_events(task_id,action,old_status,new_status,notes,signed_by,signed_by_email,payload)
  values(t.id,'status_changed',t.status,'resolved','Order fulfilled with signed customer promise: '||s.reason,s.signed_by,s.signed_by_email,
   jsonb_build_object('source','buyer_promise_fulfilled','order_id',s.order_id,'signature',s.signature));
 end loop;
 return new;
end $$;
create trigger buyer_promise_finish after update of line_status,fulfilled_quantity on public.ebay_order_lines for each row execute function public.finish_buyer_promises();

-- Ordinary task actions cannot silently remove the fulfillment requirement.
create function public.protect_buyer_promise_task() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if old.metadata->>'source' is distinct from 'buyer_followup' then
  if tg_op='DELETE' then return old;end if;
  return new;
 end if;
 if tg_op='DELETE' then raise exception 'Customer promises retain their signed history; an admin can cancel an incorrect task';end if;
 perform pg_advisory_xact_lock(hashtextextended('buyer-promise:' || (old.metadata->>'buyer_username'),0));
 if new.metadata->>'source' is distinct from old.metadata->>'source' or new.metadata->>'buyer_username' is distinct from old.metadata->>'buyer_username'
 or new.metadata->'buyer_followup_request_id' is distinct from old.metadata->'buyer_followup_request_id'
 then raise exception 'Customer promise identity cannot be changed. Ask an admin to cancel an incorrect task.';end if;
 if new.status in ('cancelled') and new.status is distinct from old.status and not coalesce(public.is_admin(),false)
 then raise exception 'Only an admin can cancel a customer promise' using errcode='42501';end if;
 if new.status in ('resolved','closed','approved_by_admin','approved_for_shipping','shipped_completed') and new.status is distinct from old.status
 and not exists(select 1 from public.buyer_promise_order_signoffs where task_id=old.id and consumed_at is not null)
 then raise exception 'Certify and sign this customer promise in Pending Orders. An admin may defer it for this order instead.';end if;
 if new.metadata#>>'{hidden_from_task_board}' is distinct from old.metadata#>>'{hidden_from_task_board}'
 or new.metadata->'history_removed_at' is distinct from old.metadata->'history_removed_at'
 or new.metadata->'assignment_cancelled_at' is distinct from old.metadata->'assignment_cancelled_at'
 or new.metadata->'assignment_canceled_at' is distinct from old.metadata->'assignment_canceled_at'
 then raise exception 'Customer promises must stay visible until fulfilled or cancelled by an admin';end if;
 return new;
end $$;
create trigger buyer_promise_protect before update or delete on public.team_tasks for each row execute function public.protect_buyer_promise_task();

revoke all on function public.buyer_promise_version(public.team_tasks),public.assert_buyer_promises_clear(uuid),public.guard_buyer_promise_fulfillment(),public.finish_buyer_promises(),public.protect_buyer_promise_task() from public,anon,authenticated;
revoke all on function public.list_buyer_promise_requirements(uuid[]),public.sign_buyer_promise(uuid,uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.list_buyer_promise_requirements(uuid[]),public.sign_buyer_promise(uuid,uuid,text,text,text,text) to authenticated;
notify pgrst,'reload schema';
commit;
