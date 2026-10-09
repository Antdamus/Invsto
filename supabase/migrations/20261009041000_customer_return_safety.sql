begin;
set local lock_timeout='3s';
set local statement_timeout='60s';
alter table public.ebay_return_items add column if not exists restocked_quantity int not null default 0 check(restocked_quantity>=0);
update public.ebay_return_items set restocked_quantity=received_quantity where stock_transaction_id is not null and disposition='restock';
create table public.customer_return_receipts(id uuid primary key,actor uuid not null,input jsonb not null,result jsonb,created_at timestamptz not null default now());
alter table public.customer_return_receipts enable row level security;
revoke all on public.customer_return_receipts from public,anon,authenticated;

create function public.add_customer_return_stock(_item uuid,_location uuid,_qty int,_line uuid,_request uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare stock_id uuid;tx uuid;source_tx uuid;
begin
 if _qty<=0 then raise exception 'Positive restock quantity required';end if;
 if _item is null then raise exception 'This order item has no verified inventory link. Keep it on hold for inventory review.';end if;
 if not exists(select 1 from public.locations where id=_location and active is true) then raise exception 'Choose an active restock location';end if;
 perform pg_advisory_xact_lock(hashtextextended('customer-return-stock:'||_item::text||':'||_location::text,0));
 select id into stock_id from public.item_stock_locations where item_id=_item and location_id=_location
  and coalesce(condition_status,'good')='good' and batch_id is null order by last_updated desc nulls last limit 1 for update;
 if stock_id is null then
  insert into public.item_stock_locations(item_id,location_id,quantity,added_by,confirmation_email,confirmation_method,confirmed_at,last_updated,condition_status)
  values(_item,_location,_qty,auth.uid(),auth.jwt()->>'email','ebay_return_restock',now(),now(),'good');
 else update public.item_stock_locations set quantity=coalesce(quantity,0)+_qty,last_updated=now() where id=stock_id;end if;
 select stock_transaction_id into source_tx from public.ebay_order_lines where id=_line;
 insert into public.stock_transactions(item_id,location_id,quantity,action_type,confirmed_at,user_id,email,notes,source_transaction_id,method,timestamp)
 values(_item,_location,_qty,'correction',now(),auth.uid(),auth.jwt()->>'email','Inspected customer return; receipt '||_request,source_tx,'ebay_return_restock',now()) returning id into tx;
 update public.metadata set inventory_version=gen_random_uuid()::text,changed_item_ids=array[_item::text],updated_at=now() where id='inventory';
 return tx;
end $$;
revoke all on function public.add_customer_return_stock(uuid,uuid,int,uuid,uuid) from public,anon,authenticated;

create function public.receive_customer_return(_request_id uuid,_case_id uuid,_items jsonb,_evidence jsonb,_notes text default null,_tracking text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.ebay_return_cases;l public.ebay_order_lines;prior public.ebay_return_items;
 receipt public.customer_return_receipts;entry jsonb;signature jsonb;qty int;already int;expected int;item_id uuid;tx uuid;
 disposition text;condition text;destination uuid;ids uuid[]:='{}';restocked int:=0;result jsonb;
begin
 if auth.uid() is null or not public.can_access_post_order_issues() then raise exception 'Customer issues access required' using errcode='42501';end if;
 if _request_id is null or _case_id is null then raise exception 'Reload the return before receiving it';end if;
 if jsonb_typeof(_items) is distinct from 'array' or jsonb_array_length(_items) not between 1 and 100 then raise exception 'Choose the returned items';end if;
 if jsonb_typeof(_evidence) is distinct from 'array' or jsonb_array_length(_evidence)>30 then raise exception 'Invalid return evidence';end if;
 signature:=jsonb_build_object('case',_case_id,'items',_items,'notes',_notes,'tracking',_tracking);
 perform pg_advisory_xact_lock(hashtextextended('return-receipt:'||_request_id::text,0));
 select * into receipt from public.customer_return_receipts where id=_request_id;
 if found then
  if receipt.actor<>auth.uid() or receipt.input<>signature then raise exception 'This receipt was already used for different return details';end if;
  return receipt.result;
 end if;
 select * into c from public.ebay_return_cases where id=_case_id for update;
 if not found or c.order_id is null or c.source_lane<>'return' then raise exception 'Link this physical return to the correct order first';end if;
 if c.status in ('closed','cancelled') then raise exception 'This return is already finished. Review its saved receipt instead of receiving it again.';end if;
 if (select count(distinct value->>'order_line_id') from jsonb_array_elements(_items))<>jsonb_array_length(_items) then raise exception 'An item appears twice in this receipt';end if;
 -- Serialize by original shipped line across every return case, not just this case.
 perform 1 from public.ebay_order_lines where id in(select (value->>'order_line_id')::uuid from jsonb_array_elements(_items)) order by id for update;
 for entry in select value from jsonb_array_elements(_items) order by value->>'order_line_id' loop
  select * into l from public.ebay_order_lines where id=(entry->>'order_line_id')::uuid and order_id=c.order_id;
  if not found or l.line_status<>'fulfilled' then raise exception 'Choose a shipped item belonging to this order';end if;
  qty:=coalesce((entry->>'received_quantity')::int,0);disposition:=coalesce(entry->>'disposition','quarantine');condition:=coalesce(entry->>'condition_received','unknown');
  if qty<0 or disposition not in ('restock','quarantine','damaged','wrong_item','refund_only','missing','admin_review') then raise exception 'Invalid return quantity or disposition';end if;
  if condition not in ('new','used_good','damaged','missing_parts','wrong_item','unknown') then raise exception 'Choose the received condition';end if;
  if qty=0 and disposition not in ('missing','refund_only') then raise exception 'Enter the quantity physically received';end if;
  if qty>0 and jsonb_array_length(_evidence)=0 then raise exception 'Add a photo or video of the received item';end if;
  if qty=0 and nullif(btrim(coalesce(entry->>'notes',_notes)), '') is null then raise exception 'Explain why no item was received';end if;
  select coalesce(sum(received_quantity),0) into already from public.ebay_return_items where order_line_id=l.id;
  if already+qty>coalesce(nullif(l.fulfilled_quantity,0),l.quantity,0) then raise exception 'This would receive more than was shipped. Check the previous return receipts.';end if;
  select * into prior from public.ebay_return_items where return_case_id=c.id and order_line_id=l.id for update;
  expected:=coalesce(prior.expected_quantity,nullif(l.fulfilled_quantity,0),l.quantity,0);
  if coalesce(prior.received_quantity,0)+qty>expected then raise exception 'This exceeds the quantity expected for this return';end if;
  if disposition='refund_only' then
   if not public.is_admin() then raise exception 'An administrator must record that no item is expected';end if;
   if coalesce(prior.received_quantity,0)>coalesce(prior.restocked_quantity,0) and prior.disposition<>'damaged' then raise exception 'Inspect the received units before recording a no-return outcome';end if;
  end if;
  -- Once an item has been inspected, use the inspection action for its remaining
  -- stock. Receiving a second parcel only records newly arrived units.
  destination:=nullif(entry->>'destination_location_id','')::uuid;tx:=null;
  if disposition='restock' then
   if condition not in ('new','used_good') then raise exception 'Only an inspected, sellable item can be restocked';end if;
   if coalesce(prior.received_quantity,0)>coalesce(prior.restocked_quantity,0) then raise exception 'Inspect the previously received units before adding a restock receipt';end if;
   tx:=public.add_customer_return_stock(l.internal_item_id,destination,qty,l.id,_request_id);restocked:=restocked+qty;
  end if;
  insert into public.ebay_return_items(return_case_id,order_id,order_line_id,internal_item_id,original_stock_location_row_id,original_location_id,
   item_title,item_number,expected_quantity,received_quantity,restocked_quantity,condition_received,disposition,destination_location_id,stock_transaction_id,processed_by,processed_by_email,processed_at,notes,metadata)
  values(c.id,c.order_id,l.id,l.internal_item_id,l.stock_location_row_id,l.location_id,l.item_title,l.item_number,expected,qty,case when disposition='restock' then qty else 0 end,
   condition,disposition,destination,tx,auth.uid(),auth.jwt()->>'email',now(),entry->>'notes',jsonb_build_object('source','customer_return_receipt','receipt_id',_request_id))
  on conflict(return_case_id,order_line_id) do update set
   received_quantity=ebay_return_items.received_quantity+excluded.received_quantity,
   restocked_quantity=ebay_return_items.restocked_quantity+excluded.restocked_quantity,
   condition_received=excluded.condition_received,disposition=excluded.disposition,
   destination_location_id=coalesce(excluded.destination_location_id,ebay_return_items.destination_location_id),stock_transaction_id=coalesce(excluded.stock_transaction_id,ebay_return_items.stock_transaction_id),
   processed_by=excluded.processed_by,processed_by_email=excluded.processed_by_email,processed_at=now(),notes=excluded.notes,
   metadata=ebay_return_items.metadata||excluded.metadata returning id into item_id;
  ids:=array_append(ids,item_id);
  insert into public.ebay_return_events(return_case_id,order_id,action,order_line_ids,return_item_ids,notes,evidence_photos,signed_by,signed_by_email,payload)
  values(c.id,c.order_id,case when disposition='restock' then 'restocked' else 'return_received' end,array[l.id],array[item_id],coalesce(entry->>'notes',_notes),_evidence,
   auth.uid(),auth.jwt()->>'email',jsonb_build_object('receipt_id',_request_id,'received_quantity',qty,'disposition',disposition,'stock_transaction_id',tx));
 end loop;
 update public.ebay_return_cases set status=case when exists(select 1 from public.ebay_return_items where return_case_id=c.id and received_quantity<expected_quantity and ebay_return_items.disposition<>'refund_only') then 'partially_received'
  when exists(select 1 from public.ebay_return_items where return_case_id=c.id and ebay_return_items.disposition in ('quarantine','wrong_item','missing','admin_review')) then 'needs_review' else 'received' end,
  received_at=coalesce(received_at,now()),return_tracking_number=coalesce(nullif(btrim(_tracking),''),return_tracking_number),updated_at=now() where id=c.id;
 result:=jsonb_build_object('return_case_ids',jsonb_build_array(c.id),'return_item_ids',to_jsonb(ids),'restocked_units',restocked,'recorded_items',cardinality(ids));
 insert into public.customer_return_receipts(id,actor,input,result) values(_request_id,auth.uid(),signature,result);
 return result;
end $$;
revoke all on function public.receive_customer_return(uuid,uuid,jsonb,jsonb,text,text) from public,anon;
grant execute on function public.receive_customer_return(uuid,uuid,jsonb,jsonb,text,text) to authenticated;

create function public.inspect_customer_return(_request_id uuid,_item_id uuid,_disposition text,_location uuid,_note text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.ebay_return_items;c public.ebay_return_cases;signature jsonb;receipt public.customer_return_receipts;tx uuid;qty int;result jsonb;
begin
 if auth.uid() is null or not public.can_access_post_order_issues() then raise exception 'Customer issues access required' using errcode='42501';end if;
 if _request_id is null or nullif(btrim(_note),'') is null then raise exception 'Add inspection notes';end if;
 if _disposition not in ('restock','damaged','wrong_item','quarantine','admin_review') then raise exception 'Choose an inspection outcome';end if;
 signature:=jsonb_build_object('item',_item_id,'disposition',_disposition,'location',_location,'note',_note);
 perform pg_advisory_xact_lock(hashtextextended('return-receipt:'||_request_id::text,0));
 select * into receipt from public.customer_return_receipts where id=_request_id;
 if found then if receipt.actor<>auth.uid() or receipt.input<>signature then raise exception 'Receipt already used';end if;return receipt.result;end if;
 select c1.* into c from public.ebay_return_cases c1 join public.ebay_return_items ri on ri.return_case_id=c1.id where ri.id=_item_id for update of c1;
 if not found or c.status in ('closed','cancelled') then raise exception 'Choose an active return';end if;
 select * into r from public.ebay_return_items where id=_item_id for update;
 qty:=r.received_quantity-r.restocked_quantity;
 if r.received_quantity=0 then raise exception 'Receive the physical item first';end if;
 if r.restocked_quantity>0 and _disposition<>'restock' then raise exception 'This item was already restocked. An inventory correction is required before changing its disposition.';end if;
 if _disposition='restock' then
  if qty<=0 then raise exception 'These units were already restocked';end if;
  tx:=public.add_customer_return_stock(r.internal_item_id,_location,qty,r.order_line_id,_request_id);
 end if;
 update public.ebay_return_items set disposition=_disposition,condition_received=case when _disposition='restock' then 'used_good' else condition_received end,
  restocked_quantity=restocked_quantity+case when _disposition='restock' then qty else 0 end,
  destination_location_id=coalesce(_location,destination_location_id),stock_transaction_id=coalesce(tx,stock_transaction_id),notes=_note,processed_at=now(),processed_by=auth.uid(),processed_by_email=auth.jwt()->>'email' where id=r.id;
 insert into public.ebay_return_events(return_case_id,order_id,action,return_item_ids,notes,signed_by,signed_by_email,payload)
 values(r.return_case_id,r.order_id,case when _disposition='restock' then 'restocked' else 'item_inspected' end,array[r.id],_note,auth.uid(),auth.jwt()->>'email',jsonb_build_object('receipt_id',_request_id,'disposition',_disposition,'stock_transaction_id',tx));
 update public.ebay_return_cases set status=case when exists(select 1 from public.ebay_return_items where return_case_id=c.id and received_quantity<expected_quantity and ebay_return_items.disposition<>'refund_only') then 'partially_received'
  when exists(select 1 from public.ebay_return_items where return_case_id=c.id and ebay_return_items.disposition in ('quarantine','wrong_item','missing','admin_review')) then 'needs_review' else 'received' end,updated_at=now() where id=c.id;
 result:=jsonb_build_object('restocked_units',case when _disposition='restock' then qty else 0 end);
 insert into public.customer_return_receipts values(_request_id,auth.uid(),signature,result,now());return result;
end $$;
revoke all on function public.inspect_customer_return(uuid,uuid,text,uuid,text) from public,anon;
grant execute on function public.inspect_customer_return(uuid,uuid,text,uuid,text) to authenticated;

-- Retire unsafe direct clients, including stale cached pages. The new UI uses
-- a durable request ID and an explicit case ID; no second inventory path remains.
revoke execute on function public.receive_ebay_return(jsonb,text,text,text,text,jsonb,text) from public,anon,authenticated;

create function public.prepare_customer_return(_line_ids uuid[],_ebay_id text default null,_reason text default null) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_order_id uuid;c public.ebay_return_cases;n int;
begin
 if auth.uid() is null or not public.can_access_post_order_issues() then raise exception 'Customer issues access required' using errcode='42501';end if;
 if coalesce(cardinality(_line_ids),0)=0 then raise exception 'Choose shipped order items';end if;
 if (select count(*) from public.ebay_order_lines where id=any(_line_ids) and line_status='fulfilled')<>cardinality(_line_ids)
  or (select count(distinct l.order_id) from public.ebay_order_lines l where id=any(_line_ids))<>1 then raise exception 'Receive one order case at a time';end if;
 select l.order_id into v_order_id from public.ebay_order_lines l where id=_line_ids[1];
 perform pg_advisory_xact_lock(hashtextextended('prepare-customer-return:'||v_order_id::text,0));
 select count(*) into n from public.ebay_return_cases rc where rc.order_id=v_order_id and source_lane='return' and status not in ('closed','cancelled')
  and (nullif(btrim(_ebay_id),'') is null or ebay_return_id=_ebay_id);
 if n>1 then raise exception 'Several return cases match this order. Open Customer Issues and choose the correct case.';end if;
 select * into c from public.ebay_return_cases rc where rc.order_id=v_order_id and source_lane='return' and status not in ('closed','cancelled')
  and (nullif(btrim(_ebay_id),'') is null or ebay_return_id=_ebay_id) limit 1;
 if c.id is not null then return c.id;end if;
 if nullif(btrim(_ebay_id),'') is not null and exists(select 1 from public.ebay_return_cases where source_lane='return' and ebay_return_id=_ebay_id) then raise exception 'That eBay return already exists. Open its case instead.';end if;
 insert into public.ebay_return_cases(order_id,order_number,buyer_username,ebay_return_id,status,source_lane,issue_kind,return_reason,created_by,created_by_email,raw_payload)
 select o.id,o.order_number,o.buyer_username,nullif(btrim(_ebay_id),''),'open','return','return',_reason,auth.uid(),auth.jwt()->>'email',jsonb_build_object('source','manual_return_intake') from public.ebay_orders o where id=v_order_id returning * into c;
 insert into public.ebay_return_tasks(return_case_id,order_id,order_line_ids,task_type,title,question,status,assigned_to_user_id,assigned_by,created_by,created_by_email,metadata)
 values(c.id,c.order_id,_line_ids,'return_intake','Inspect the returned items','Receive, photograph and inspect the returned items.','assigned',auth.uid(),auth.uid(),auth.uid(),auth.jwt()->>'email',jsonb_build_object('request_kind','work','source','manual_return_intake'));
 return c.id;
end $$;
revoke all on function public.prepare_customer_return(uuid[],text,text) from public,anon;
grant execute on function public.prepare_customer_return(uuid[],text,text) to authenticated;

create function public.link_customer_issue_order(_case_id uuid,_order_id uuid,_line_ids uuid[],_note text,_expected_updated_at timestamptz) returns void
language plpgsql security definer set search_path='' as $$
declare c public.ebay_return_cases;o public.ebay_orders;
begin
 if not public.is_admin() then raise exception 'An administrator must verify the order match' using errcode='42501';end if;
 select * into c from public.ebay_return_cases where id=_case_id for update;
 if not found or c.updated_at is distinct from _expected_updated_at then raise exception 'This case changed. Refresh before linking it.';end if;
 select * into o from public.ebay_orders where id=_order_id;
 if not found or cardinality(_line_ids)=0 or _line_ids is null or nullif(btrim(_note),'') is null then raise exception 'Choose the order items and explain the match';end if;
 if (select count(*) from public.ebay_order_lines where order_id=_order_id and id=any(_line_ids))<>cardinality(_line_ids) then raise exception 'All items must belong to this order';end if;
 if exists(select 1 from public.ebay_return_items where return_case_id=c.id and (received_quantity>0 or stock_transaction_id is not null)) then raise exception 'A return was already received. Its order cannot be changed here.';end if;
 update public.ebay_return_cases set order_id=o.id,order_number=o.order_number,buyer_username=o.buyer_username,case_type='matched_order',updated_at=now(),
  raw_payload=raw_payload||jsonb_build_object('manualOrderMatch',jsonb_build_object('order_id',o.id,'line_ids',to_jsonb(_line_ids),'by',auth.uid(),'at',now(),'note',_note)) where id=c.id;
 update public.ebay_return_tasks set order_id=o.id,order_line_ids=_line_ids where return_case_id=c.id and status not in ('resolved','cancelled');
 -- Only remove unreceived placeholders when replacing a confirmed association.
 delete from public.ebay_return_items where return_case_id=c.id and received_quantity=0 and not(order_line_id=any(_line_ids));
 if c.source_lane='return' then
  insert into public.ebay_return_items(return_case_id,order_id,order_line_id,internal_item_id,item_title,item_number,expected_quantity)
  select c.id,o.id,l.id,l.internal_item_id,l.item_title,l.item_number,l.quantity from public.ebay_order_lines l where id=any(_line_ids)
  on conflict(return_case_id,order_line_id) do nothing;
 end if;
 insert into public.ebay_return_events(return_case_id,order_id,order_line_ids,action,notes,signed_by,signed_by_email,payload)
 values(c.id,o.id,_line_ids,'admin_override',_note,auth.uid(),auth.jwt()->>'email',jsonb_build_object('source','verified_order_match','previous_order_id',c.order_id));
end $$;
revoke all on function public.link_customer_issue_order(uuid,uuid,uuid[],text,timestamptz) from public,anon;
grant execute on function public.link_customer_issue_order(uuid,uuid,uuid[],text,timestamptz) to authenticated;
commit;
