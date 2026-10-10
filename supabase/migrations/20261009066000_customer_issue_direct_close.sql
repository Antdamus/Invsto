begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

-- Administrative closeout of an already-resolved case. Imported item placeholders
-- are not receipts: archiving must never invent received quantities or move stock.
create function public.close_resolved_customer_issue(
 _case_id uuid, _expected_updated_at timestamptz, _expected_tasks jsonb,
 _confirmed boolean, _note text default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 c public.ebay_return_cases;
 t public.ebay_return_tasks;
 snapshot jsonb;
 expected jsonb;
 item_snapshot jsonb;
 total int:=0;
 stamp timestamptz:=now();
 outcome text:=coalesce(nullif(btrim(_note),''),'Already resolved; no further internal work is required.');
begin
 if auth.uid() is null or not coalesce(public.is_admin(),false) or not coalesce(public.can_access_post_order_issues(),false)
 then raise exception 'An administrator must close this case' using errcode='42501'; end if;
 if _confirmed is distinct from true then raise exception 'Confirm that the case is resolved and no further work is needed'; end if;
 if length(outcome)>10000 then raise exception 'Keep the closing note under 10,000 characters'; end if;
 select * into c from public.ebay_return_cases where id=_case_id for update;
 if not found then raise exception 'Case not found'; end if;
 -- Lock existing tasks before comparing the operator's preview with current work.
 perform 1 from public.ebay_return_tasks where return_case_id=c.id order by id for update;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'updated_at',updated_at) order by id),'[]'::jsonb)
 into snapshot from public.ebay_return_tasks where return_case_id=c.id
 and status not in ('resolved','cancelled','closed','approved_by_admin');
 if c.status in ('closed','cancelled') and snapshot='[]'::jsonb then
  return jsonb_build_object('case_id',c.id,'status',c.status,'closed_tasks',0,'already_closed',true);
 end if;
 if c.updated_at is distinct from _expected_updated_at then raise exception 'This case changed. Refresh it and review the latest information before closing'; end if;
 if jsonb_typeof(_expected_tasks) is distinct from 'array' then raise exception 'Refresh the case to review its follow-ups'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'updated_at',s.updated_at) order by s.id),'[]'::jsonb)
 into expected from jsonb_to_recordset(_expected_tasks) as s(id uuid,updated_at timestamptz);
 if expected is distinct from snapshot then raise exception 'The follow-ups changed. Refresh the case and review them before closing'; end if;
 if c.ebay_return_id is not null and coalesce(c.ebay_status,'') !~* '(^|_)(CLOSED|CANCELLED|CANCELED|RESOLVED|SELLER_WON|SELLER_LOST|DISPUTE_REVERSED)($|_)'
 then raise exception 'eBay still reports this case open. Use Refresh case after it is closed on eBay'; end if;
 -- A saved terminal eBay outcome can be archived even when its last sync is old.
 -- The operator explicitly confirms completion; a real eBay reopening still
 -- reopens the case through the existing sync/action-cycle reconciliation.
 perform 1 from public.ebay_return_items where return_case_id=c.id order by id for update;
 if exists(select 1 from public.ebay_return_items where return_case_id=c.id and received_quantity>restocked_quantity
  and disposition not in ('received_no_restock','damaged','refund_only'))
 then raise exception 'Inspect the received items first: record their final condition and whether they should be restocked. No task assignment is required'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'expected_quantity',expected_quantity,'received_quantity',received_quantity,
  'restocked_quantity',restocked_quantity,'disposition',disposition) order by id),'[]'::jsonb)
 into item_snapshot from public.ebay_return_items where return_case_id=c.id;
 for t in select * from public.ebay_return_tasks where return_case_id=c.id
  and status not in ('resolved','cancelled','closed','approved_by_admin') order by id
 loop
  -- Cancel obsolete follow-ups rather than claiming an employee performed work
  -- or creating a new completion/review notification. Ownership stays untouched.
  update public.ebay_return_tasks set status='cancelled',resolved_at=stamp,resolved_by=auth.uid(),
   resolved_by_email=auth.jwt()->>'email',resolution_notes=outcome,updated_at=stamp,
   metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('case_closeout',jsonb_build_object(
    'at',stamp,'by',auth.uid(),'previous_status',t.status,'reason','already_resolved'))
  where id=t.id;
  insert into public.ebay_return_task_events(task_id,return_case_id,action,old_status,new_status,notes,signed_by,signed_by_email,payload)
  values(t.id,c.id,'cancelled',t.status,'cancelled','Follow-up closed with the resolved case. '||outcome,auth.uid(),auth.jwt()->>'email',
   jsonb_build_object('source','customer_issue_direct_close','previous_task',to_jsonb(t)));
  total:=total+1;
 end loop;
 update public.ebay_return_cases set status='closed',closed_at=coalesce(closed_at,stamp),updated_at=stamp where id=c.id;
 insert into public.ebay_return_events(return_case_id,order_id,action,notes,signed_by,signed_by_email,payload)
 values(c.id,c.order_id,'closed',outcome,auth.uid(),auth.jwt()->>'email',jsonb_build_object(
  'source','customer_issue_direct_close','confirmed_resolved',true,'previous_status',c.status,'ebay_status',c.ebay_status,
  'last_ebay_sync',c.synced_at,'closed_tasks',total,'items_at_close',item_snapshot,'inventory_changed',false));
 return jsonb_build_object('case_id',c.id,'status','closed','closed_tasks',total,'already_closed',false);
end $$;
revoke all on function public.close_resolved_customer_issue(uuid,timestamptz,jsonb,boolean,text) from public,anon;
grant execute on function public.close_resolved_customer_issue(uuid,timestamptz,jsonb,boolean,text) to authenticated;
notify pgrst, 'reload schema';
commit;
