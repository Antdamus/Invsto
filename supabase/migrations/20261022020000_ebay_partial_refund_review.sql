begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

-- Preserve the unreviewed guard. Refund approval never edits eBay's source facts.
do $$declare def text;begin
 select pg_get_functiondef('public.ebay_fulfillment_block(jsonb,jsonb)'::regprocedure) into def;
 if position('Refund recorded by eBay Finances' in def)=0 then raise exception 'Missing finance refund guard';end if;
 execute replace(def,'public.ebay_fulfillment_block(', 'public.ebay_fulfillment_block_unreviewed(');
end $$;

create function public.ebay_refund_review_facts(_row jsonb) returns jsonb
language sql immutable set search_path='' as $$
 select jsonb_build_object(
  'quantity',_row->'quantity','item_number',_row->'item_number','transaction_id',_row->'transaction_id',
  'total_price',_row->'total_price','sold_for',_row->'sold_for','source_total',p#>'{order,pricingSummary,total}',
  'payments',jsonb_build_array(p->'orderPaymentStatus',p#>'{order,orderPaymentStatus}',p#>'{pending_order_sync_mismatch,ebayPaymentStatus}',p#>'{api_order_status,payment_status}',p#>'{order,paymentSummary,payments,0,paymentStatus}'),
  'cancellations',jsonb_build_array(p->'orderCancelStatus',p#>'{order,cancelStatus,cancelState}',p#>'{order,cancelStatus,cancelStatus}',p#>'{pending_order_sync_mismatch,ebayCancelStatus}',p#>'{api_order_status,cancel_status}',p#>'{api_cancellation_case,cancelStatus}',p#>'{cancellation_page_case,cancelStatus}'),
  'refunds',p#>'{order,paymentSummary,refunds}',
  'transactions',coalesce((select jsonb_agg(t order by t::text) from jsonb_array_elements(case when jsonb_typeof(p#>'{ebayFinance,transactions}')='array' then p#>'{ebayFinance,transactions}' else '[]'::jsonb end) t where upper(t->>'transactionType')='REFUND'),'[]'::jsonb))
 from (select coalesce(_row->'raw_payload','{}'::jsonb) p) s;
$$;

-- Inspect every source, including a line cancellation hidden by an order refund.
create function public.ebay_partial_refund_hard_block(_order jsonb,_line jsonb default '{}') returns text
language plpgsql immutable set search_path='' as $$
declare row_data jsonb;facts jsonb;value jsonb;status text;
begin
 if lower(coalesce(_order->>'status','')) in ('cancelled','canceled','archived','closed','refunded') then return 'Order is cancelled or closed';end if;
 if lower(coalesce(_line->>'line_status','')) in ('cancelled','canceled','skipped','closed','refunded') then return 'Item is cancelled or closed';end if;
 foreach row_data in array array[_order,_line] loop
  facts:=public.ebay_refund_review_facts(row_data);
  for value in select * from jsonb_array_elements(facts->'payments') loop
   status:=upper(coalesce(value#>>'{}',''));
   if status in ('REFUNDED','FULLY_REFUNDED','REFUND_PENDING','PENDING_REFUND') then return 'Full or pending refund reported; partial-refund approval is unavailable';end if;
   if status in ('UNPAID','PENDING','FAILED','PAYMENT_FAILED','PARTIALLY_PAID') then return 'Payment is not confirmed';end if;
  end loop;
  for value in select * from jsonb_array_elements(facts->'cancellations') loop
   status:=upper(coalesce(value#>>'{}',''));
   if status not in ('','NONE_REQUESTED','NOT_REQUESTED','NO_CANCEL','NOT_CANCELLED','CANCEL_REJECTED','CANCEL_CLOSED_WITHOUT_REFUND') then return 'Cancellation reported by eBay: '||status;end if;
  end loop;
 end loop;
 return null;
end $$;

create function public.ebay_partial_refund_snapshot(_order_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('order',public.ebay_refund_review_facts(to_jsonb(o)),
  'lines',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'facts',public.ebay_refund_review_facts(to_jsonb(l))) order by l.id) from public.ebay_order_lines l where l.order_id=o.id),'[]'::jsonb))
 from public.ebay_orders o where o.id=_order_id;
$$;

create table public.ebay_partial_refund_approvals(
 id uuid primary key default gen_random_uuid(),
 order_id uuid not null references public.ebay_orders(id),
 snapshot jsonb not null,
 reason text not null check(length(btrim(reason)) between 3 and 2000),
 approved_by uuid not null references auth.users(id),
 approved_by_email text not null,
 approved_at timestamptz not null default now(),
 revoked_at timestamptz,
 revocation_reason text
);
create unique index ebay_partial_refund_active_order on public.ebay_partial_refund_approvals(order_id) where revoked_at is null;
alter table public.ebay_partial_refund_approvals enable row level security;
revoke all on public.ebay_partial_refund_approvals from public,anon,authenticated;
grant select on public.ebay_partial_refund_approvals to authenticated;
create policy ebay_partial_refund_audit_read on public.ebay_partial_refund_approvals for select to authenticated using(public.can_manage_inventory());

create or replace function public.ebay_fulfillment_block(_order jsonb,_line jsonb default '{}') returns text
language plpgsql stable security definer set search_path='' as $$
declare reason text;hard_block text;oid uuid;o jsonb;stored_line jsonb;
begin
 reason:=public.ebay_fulfillment_block_unreviewed(_order,_line);
 if reason is null or reason not like 'Refund%' then return reason;end if;
 hard_block:=public.ebay_partial_refund_hard_block(_order,_line);
 if hard_block is not null then return reason;end if;
 oid:=coalesce(nullif(_order->>'id',''),nullif(_line->>'order_id',''))::uuid;
 if oid is null then return reason;end if;
 select to_jsonb(e) into o from public.ebay_orders e where e.id=oid;
 if o is null or public.ebay_partial_refund_hard_block(o,_line) is not null then return reason;end if;
 -- BEFORE triggers may be checking NEW data not yet visible in the table.
 if _order ? 'id' and public.ebay_refund_review_facts(_order) is distinct from public.ebay_refund_review_facts(o) then return reason;end if;
 if _line ? 'id' then
  select to_jsonb(l) into stored_line from public.ebay_order_lines l where l.id=(_line->>'id')::uuid and l.order_id=oid;
  if stored_line is null or public.ebay_refund_review_facts(_line) is distinct from public.ebay_refund_review_facts(stored_line) then return reason;end if;
 end if;
 if exists(select 1 from public.ebay_partial_refund_approvals a where a.order_id=oid and a.revoked_at is null and a.snapshot=public.ebay_partial_refund_snapshot(oid)) then return null;end if;
 return reason;
end $$;

create function public.get_ebay_partial_refund_reviews(_order_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare o public.ebay_orders;l public.ebay_order_lines;result jsonb:='[]';reason text;hard_block text;has_refund boolean;approval jsonb;review_snapshot jsonb;items jsonb;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory staff access required' using errcode='42501';end if;
 if coalesce(cardinality(_order_ids),0) not between 1 and 500 then raise exception 'Select 1 to 500 orders';end if;
 for o in select * from public.ebay_orders where id=any(_order_ids) order by id loop
  reason:=public.ebay_fulfillment_block_unreviewed(to_jsonb(o));
  has_refund:=coalesce(reason like 'Refund%',false);
  hard_block:=public.ebay_partial_refund_hard_block(to_jsonb(o));items:='[]';
  for l in select * from public.ebay_order_lines where order_id=o.id order by id loop
   has_refund:=has_refund or coalesce(public.ebay_fulfillment_block_unreviewed(to_jsonb(o),to_jsonb(l)) like 'Refund%',false);
   hard_block:=coalesce(hard_block,public.ebay_partial_refund_hard_block(to_jsonb(o),to_jsonb(l)));
   items:=items||jsonb_build_array(jsonb_build_object('id',l.id,'title',l.item_title,'quantity',to_jsonb(l)->'quantity'));
  end loop;
  review_snapshot:=public.ebay_partial_refund_snapshot(o.id);approval:=null;
  select jsonb_build_object('id',a.id,'by',a.approved_by_email,'at',a.approved_at,'reason',a.reason) into approval from public.ebay_partial_refund_approvals a where a.order_id=o.id and a.revoked_at is null and a.snapshot=review_snapshot;
  result:=result||jsonb_build_array(jsonb_build_object('order_id',o.id,'order_number',o.order_number,'items',items,'snapshot',review_snapshot,'reviewable',has_refund and hard_block is null,'blocked_reason',hard_block,'approval',case when hard_block is null then approval end));
 end loop;
 return result;
end $$;

create function public.approve_ebay_partial_refund(_order_id uuid,_snapshot jsonb,_reason text,_confirmed boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare review jsonb;signer text;result jsonb;
begin
 if auth.uid() is null or not coalesce(public.can_revert_order_fulfillment(),false) or not coalesce(public.can_manage_inventory(),false) then raise exception 'Only active admins and managers can approve partial refunds' using errcode='42501';end if;
 -- Supabase's signed AMR timestamp proves a recent password authentication.
 if not exists(select 1 from jsonb_array_elements(case when jsonb_typeof(auth.jwt()->'amr')='array' then auth.jwt()->'amr' else '[]'::jsonb end) a
  where a->>'method'='password' and case when a->>'timestamp' ~ '^\d{1,12}$' then (a->>'timestamp')::numeric between extract(epoch from now())-300 and extract(epoch from now())+30 else false end)
 then raise exception 'Confirm your password again before approving this partial refund' using errcode='42501';end if;
 if not coalesce(_confirmed,false) then raise exception 'Confirm that you verified a partial refund and this order should still ship';end if;
 if length(btrim(coalesce(_reason,''))) not between 3 and 2000 then raise exception 'Record the refund amount and why the order should still ship (3 to 2000 characters)';end if;
 perform public.lock_shared_inventory();
 perform 1 from public.ebay_orders where id=_order_id for update;
 if not found then raise exception 'Order no longer exists';end if;
 perform 1 from public.ebay_order_lines where order_id=_order_id order by id for update;
 review:=public.get_ebay_partial_refund_reviews(array[_order_id])->0;
 if not coalesce((review->>'reviewable')::boolean,false) then raise exception '%',coalesce(review->>'blocked_reason','No reviewable refund found. Refresh the order.');end if;
 if _snapshot is distinct from review->'snapshot' then raise exception 'Refund or order items changed. Reopen the review and verify the latest eBay details.';end if;
 if review->'approval' <> 'null'::jsonb then return review->'approval';end if;
 select email into signer from auth.users where id=auth.uid();
 insert into public.ebay_partial_refund_approvals(order_id,snapshot,reason,approved_by,approved_by_email)
 values(_order_id,_snapshot,btrim(_reason),auth.uid(),signer)
 returning jsonb_build_object('id',id,'by',approved_by_email,'at',approved_at,'reason',reason) into result;
 return result;
end $$;

-- Any changed refund, cancellation, or item set needs a fresh review. Keep history.
create function public.invalidate_ebay_partial_refund_approval() returns trigger
language plpgsql security definer set search_path='' as $$
declare oid uuid;p record;
begin
 for oid in select distinct x from unnest(array[
  (case when tg_table_name='ebay_orders' then to_jsonb(new)->>'id' when tg_op='DELETE' then to_jsonb(old)->>'order_id' else to_jsonb(new)->>'order_id' end)::uuid,
  (case when tg_table_name='ebay_order_lines' and tg_op='UPDATE' then to_jsonb(old)->>'order_id' end)::uuid]) x where x is not null loop
 update public.ebay_partial_refund_approvals a set revoked_at=now(),revocation_reason='Order, refund, or cancellation facts changed'
 where a.order_id=oid and a.revoked_at is null and (a.snapshot is distinct from public.ebay_partial_refund_snapshot(oid)
  or exists(select 1 from public.ebay_orders o left join public.ebay_order_lines l on l.order_id=o.id where o.id=oid and public.ebay_partial_refund_hard_block(to_jsonb(o),coalesce(to_jsonb(l),'{}')) is not null));
 if found then
  insert into public.ebay_fulfillment_safety_events(order_id,previous_reason,reason,source)
   values(oid,null,'Partial refund approval expired; review the changed order','partial_refund_approval_changed');
  for p in update public.packaging_shipments set status='on_hold',hold_reason='Partial refund approval expired; review the changed order',revision=revision+1,updated_at=now()
   where oid=any(order_ids) and status in ('in_progress','ready') returning id,created_by loop
   insert into public.packaging_events(shipment_id,request_id,action,notes,payload,created_by)
    values(p.id,gen_random_uuid(),'payment_safety_hold','Partial refund approval expired; review the changed order',jsonb_build_object('order_id',oid),coalesce(auth.uid(),p.created_by));
  end loop;
 end if;
 end loop;
 return null;
end $$;
create trigger invalidate_partial_refund_order after update of status,raw_payload on public.ebay_orders for each row execute function public.invalidate_ebay_partial_refund_approval();
create trigger invalidate_partial_refund_line after insert or update or delete on public.ebay_order_lines for each row execute function public.invalidate_ebay_partial_refund_approval();

revoke all on function public.ebay_fulfillment_block_unreviewed(jsonb,jsonb),public.ebay_refund_review_facts(jsonb),public.ebay_partial_refund_hard_block(jsonb,jsonb),public.ebay_partial_refund_snapshot(uuid),public.invalidate_ebay_partial_refund_approval() from public,anon,authenticated;
revoke all on function public.get_ebay_partial_refund_reviews(uuid[]),public.approve_ebay_partial_refund(uuid,jsonb,text,boolean) from public,anon,authenticated;
grant execute on function public.get_ebay_partial_refund_reviews(uuid[]),public.approve_ebay_partial_refund(uuid,jsonb,text,boolean) to authenticated;
notify pgrst,'reload schema';
commit;
