-- FedEx 1D carries routing fields plus a zero-padded 14-character tracking field.
-- https://www.fedex.com/en-us/developer/announcements.html
-- Keep this return-specific: changing the shared immutable packaging function
-- would invalidate the meaning of existing expression indexes.
begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

create or replace function public.customer_return_tracking_number(_text text) returns text
language plpgsql immutable set search_path='' as $$
declare raw text:=public.packaging_normalize_tracking(btrim(_text));barcode text;tracking text;
begin
 barcode:=regexp_replace(raw,'[()]','','g');
 if barcode ~ '^96[0-9]{32}$' then
  tracking:=substring(barcode from 21 for 14);
  return case when left(tracking,2)='00' then substring(tracking from 3) else tracking end;
 end if;
 return raw;
end $$;
create index if not exists customer_returns_canonical_tracking_idx
 on public.ebay_return_cases(public.customer_return_tracking_number(return_tracking_number));

alter table public.ebay_return_items drop constraint ebay_return_items_disposition_check;
alter table public.ebay_return_items add constraint ebay_return_items_disposition_check
 check(disposition in ('restock','received_no_restock','quarantine','damaged','wrong_item','refund_only','missing','admin_review'));

create or replace function public.receive_customer_return(_request_id uuid,_case_id uuid,_items jsonb,_evidence jsonb,_notes text default null,_tracking text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.ebay_return_cases;l public.ebay_order_lines;prior public.ebay_return_items;
 receipt public.customer_return_receipts;entry jsonb;signature jsonb;qty int;already int;expected int;item_id uuid;tx uuid;
 item_note text;disposition text;condition text;destination uuid;ids uuid[]:='{}';restocked int:=0;result jsonb;
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
  if qty<0 or disposition not in ('restock','received_no_restock','quarantine','damaged','wrong_item','refund_only','missing','admin_review') then raise exception 'Invalid return quantity or disposition';end if;
  if condition not in ('new','used_good','damaged','missing_parts','wrong_item','unknown') then raise exception 'Choose the received condition';end if;
  if qty=0 and disposition not in ('missing','refund_only') then raise exception 'Enter the quantity physically received';end if;
  if qty>0 and jsonb_array_length(_evidence)=0 then raise exception 'Add a photo or video of the received item';end if;
  item_note:=nullif(concat_ws(E'\n',nullif(btrim(_notes),''),case when btrim(coalesce(entry->>'notes','')) is distinct from btrim(coalesce(_notes,'')) then nullif(btrim(entry->>'notes'),'') end),'');
  if (qty=0 or disposition in ('damaged','wrong_item','missing','admin_review','refund_only') or condition in ('damaged','missing_parts','wrong_item')) and item_note is null then raise exception 'Explain what is missing, damaged, incorrect or needs a decision';end if;
  select coalesce(sum(received_quantity),0) into already from public.ebay_return_items where order_line_id=l.id;
  if already+qty>coalesce(nullif(l.fulfilled_quantity,0),l.quantity,0) then raise exception 'This would receive more than was shipped. Check the previous return receipts.';end if;
  select * into prior from public.ebay_return_items where return_case_id=c.id and order_line_id=l.id for update;
  expected:=coalesce(prior.expected_quantity,nullif(l.fulfilled_quantity,0),l.quantity,0);
  if coalesce(prior.received_quantity,0)+qty>expected then raise exception 'This exceeds the quantity expected for this return';end if;
  if disposition='received_no_restock' then
   if condition not in ('new','used_good') then raise exception 'Inspect the item first, or choose Hold for inspection';end if;
   if coalesce(prior.received_quantity,0)>0 and prior.disposition<>'received_no_restock' then raise exception 'Inspect the previously received units before recording another receipt without restocking';end if;
  end if;
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
   condition,disposition,destination,tx,auth.uid(),auth.jwt()->>'email',now(),item_note,jsonb_build_object('source','customer_return_receipt','receipt_id',_request_id))
  on conflict(return_case_id,order_line_id) do update set
   received_quantity=ebay_return_items.received_quantity+excluded.received_quantity,
   restocked_quantity=ebay_return_items.restocked_quantity+excluded.restocked_quantity,
   condition_received=excluded.condition_received,disposition=excluded.disposition,
   destination_location_id=coalesce(excluded.destination_location_id,ebay_return_items.destination_location_id),stock_transaction_id=coalesce(excluded.stock_transaction_id,ebay_return_items.stock_transaction_id),
   processed_by=excluded.processed_by,processed_by_email=excluded.processed_by_email,processed_at=now(),notes=excluded.notes,
   metadata=ebay_return_items.metadata||excluded.metadata returning id into item_id;
  ids:=array_append(ids,item_id);
  insert into public.ebay_return_events(return_case_id,order_id,action,order_line_ids,return_item_ids,notes,evidence_photos,signed_by,signed_by_email,payload)
  values(c.id,c.order_id,case when disposition='restock' then 'restocked' else 'return_received' end,array[l.id],array[item_id],item_note,_evidence,
   auth.uid(),auth.jwt()->>'email',jsonb_build_object('receipt_id',_request_id,'received_quantity',qty,'disposition',disposition,'stock_transaction_id',tx,'tracking_scan',_tracking,'tracking_number',public.customer_return_tracking_number(_tracking)));
 end loop;
 update public.ebay_return_cases set status=case when exists(select 1 from public.ebay_return_items where return_case_id=c.id and received_quantity<expected_quantity and ebay_return_items.disposition<>'refund_only') then 'partially_received'
  when exists(select 1 from public.ebay_return_items where return_case_id=c.id and ebay_return_items.disposition in ('quarantine','damaged','wrong_item','missing','admin_review')) then 'needs_review' else 'received' end,
  received_at=coalesce(received_at,now()),return_tracking_number=coalesce(nullif(public.customer_return_tracking_number(_tracking),''),return_tracking_number),updated_at=now() where id=c.id;
 result:=jsonb_build_object('return_case_ids',jsonb_build_array(c.id),'return_item_ids',to_jsonb(ids),'restocked_units',restocked,'recorded_items',cardinality(ids));
 insert into public.customer_return_receipts(id,actor,input,result) values(_request_id,auth.uid(),signature,result);
 return result;
end $$;
revoke all on function public.receive_customer_return(uuid,uuid,jsonb,jsonb,text,text) from public,anon;
grant execute on function public.receive_customer_return(uuid,uuid,jsonb,jsonb,text,text) to authenticated;

create or replace function public.inspect_customer_return(_request_id uuid,_item_id uuid,_disposition text,_location uuid,_note text,_evidence jsonb default '[]') returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.ebay_return_items;c public.ebay_return_cases;signature jsonb;receipt public.customer_return_receipts;tx uuid;qty int;result jsonb;
begin
 if auth.uid() is null or not public.can_access_post_order_issues() then raise exception 'Customer issues access required' using errcode='42501';end if;
 if _request_id is null or nullif(btrim(_note),'') is null then raise exception 'Add inspection notes';end if;
 if _disposition not in ('restock','received_no_restock','damaged','wrong_item','quarantine','admin_review') then raise exception 'Choose an inspection outcome';end if;
 if jsonb_typeof(_evidence) is distinct from 'array' or jsonb_array_length(_evidence)>30 then raise exception 'Use up to 30 inspection photos or videos';end if;
 signature:=jsonb_build_object('item',_item_id,'disposition',_disposition,'location',_location,'note',_note,'evidence',_evidence);
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
 update public.ebay_return_items set disposition=_disposition,condition_received=case when _disposition in ('restock','received_no_restock') then 'used_good' else condition_received end,
  restocked_quantity=restocked_quantity+case when _disposition='restock' then qty else 0 end,
  destination_location_id=coalesce(_location,destination_location_id),stock_transaction_id=coalesce(tx,stock_transaction_id),notes=_note,processed_at=now(),processed_by=auth.uid(),processed_by_email=auth.jwt()->>'email' where id=r.id;
 insert into public.ebay_return_events(return_case_id,order_id,action,return_item_ids,notes,evidence_photos,signed_by,signed_by_email,payload)
 values(r.return_case_id,r.order_id,case when _disposition='restock' then 'restocked' else 'item_inspected' end,array[r.id],_note,_evidence,auth.uid(),auth.jwt()->>'email',jsonb_build_object('receipt_id',_request_id,'disposition',_disposition,'stock_transaction_id',tx));
 update public.ebay_return_cases set status=case when exists(select 1 from public.ebay_return_items where return_case_id=c.id and received_quantity<expected_quantity and ebay_return_items.disposition<>'refund_only') then 'partially_received'
  when exists(select 1 from public.ebay_return_items where return_case_id=c.id and ebay_return_items.disposition in ('quarantine','damaged','wrong_item','missing','admin_review')) then 'needs_review' else 'received' end,updated_at=now() where id=c.id;
 result:=jsonb_build_object('restocked_units',case when _disposition='restock' then qty else 0 end);
 insert into public.customer_return_receipts values(_request_id,auth.uid(),signature,result,now());return result;
end $$;
revoke all on function public.inspect_customer_return(uuid,uuid,text,uuid,text,jsonb) from public,anon;
grant execute on function public.inspect_customer_return(uuid,uuid,text,uuid,text,jsonb) to authenticated;

create or replace function public.lookup_customer_return_package(_code text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare code text:=public.customer_return_tracking_number(_code);raw_code text:=public.packaging_normalize_tracking(btrim(_code));codes text[];result jsonb;
begin
 if auth.uid() is null or not public.can_access_post_order_issues() then raise exception 'Customer issues access required' using errcode='42501';end if;
 if length(code) not between 5 and 100 or code !~ '^[A-Z0-9-]+$' then raise exception 'Scan a tracking barcode, or enter the order number or eBay return ID';end if;
 codes:=array[code,raw_code];
 with direct_cases as materialized (
  select c.id,c.order_id,'return_tracking'::text matched_by from public.ebay_return_cases c where c.source_lane='return' and public.customer_return_tracking_number(c.return_tracking_number)=code
  union select c.id,c.order_id,'case_id' from public.ebay_return_cases c where c.source_lane='return' and c.ebay_return_id=code
 ), matched_orders as materialized (
  select o.id from public.ebay_orders o where o.order_number=code or public.packaging_normalize_tracking(o.tracking_number)=any(codes) or public.packaging_tracking_keys(o.label_metadata)&&codes
  union select unnest(p.order_ids) from public.packaging_shipments p where p.status<>'cancelled' and p.tracking_code=any(codes)
  union select unnest(e.order_ids) from public.ebay_order_label_events e where e.action in ('attached','extra_label') and public.packaging_tracking_keys(e.label_metadata)&&codes
 ), candidates as (
  select c.*,d.matched_by from public.ebay_return_cases c join direct_cases d on d.id=c.id
  union all select c.*,'original_label_or_order' from public.ebay_return_cases c join matched_orders o on o.id=c.order_id where c.source_lane='return' and not exists(select 1 from direct_cases)
 ), matches as (
  select jsonb_build_object('case_id',c.id,'order_id',c.order_id,'order_number',c.order_number,'buyer',c.buyer_username,'case_reference',c.ebay_return_id,'status',c.status,'opened_at',c.opened_at,'item_title',c.item_title,'matched_by',c.matched_by) value from candidates c
  union all
  select jsonb_build_object('case_id',null,'order_id',o.id,'order_number',o.order_number,'buyer',o.buyer_username,'status','not_received','matched_by','original_label_or_order') from public.ebay_orders o join matched_orders m on m.id=o.id
   where not exists(select 1 from direct_cases) and not exists(select 1 from public.ebay_return_cases c where c.order_id=o.id and c.source_lane='return')
   and exists(select 1 from public.ebay_order_lines l where l.order_id=o.id and l.line_status='fulfilled' and l.fulfilled_quantity>0)
 ) select coalesce(jsonb_agg(value),'[]') into result from (select value from matches order by value->>'order_number',value->>'case_id' limit 21) q;
 return jsonb_build_object('tracking_number',code,'barcode_decoded',code<>raw_code,'matches',result,'too_many',jsonb_array_length(result)>20);
end $$;
revoke all on function public.lookup_customer_return_package(text) from public,anon;
grant execute on function public.lookup_customer_return_package(text) to authenticated;

notify pgrst,'reload schema';
commit;
