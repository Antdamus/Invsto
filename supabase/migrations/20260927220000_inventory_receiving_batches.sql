-- Receive existing inventory in one atomic, retry-safe batch.
begin;
create table public.inventory_receiving_receipts (
 user_id uuid not null references auth.users(id), request_id uuid not null,
 payload jsonb not null, result jsonb not null, created_at timestamptz not null default now(),
 primary key (user_id,request_id)
);
alter table public.inventory_receiving_receipts enable row level security;
revoke all on public.inventory_receiving_receipts from public,anon,authenticated;

create function public.get_inventory_receiving_receipt(_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_result jsonb;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501'; end if;
 if _request_id is null then raise exception 'Request id required' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('receive:'||auth.uid()::text||_request_id::text,0));
 select result into v_result from public.inventory_receiving_receipts where user_id=auth.uid() and request_id=_request_id;
 return v_result;
end $$;

create function public.receive_inventory_batch(_request_id uuid,_location_id uuid,_lines jsonb,_notes text default '') returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 v_payload jsonb; v_prior public.inventory_receiving_receipts; v_location public.locations;
 v_line record; v_stock_id uuid; v_tx_id uuid; v_email text; v_results jsonb := '[]';
 v_notes text := btrim(coalesce(_notes,'')); v_existing bigint; v_total bigint; v_after bigint;
 v_result jsonb; v_title text; v_barcode text;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501'; end if;
 if _request_id is null or _location_id is null then raise exception 'Choose a destination and valid request id' using errcode='22023'; end if;
 if jsonb_typeof(_lines) is distinct from 'array' then raise exception 'Add at least one existing item' using errcode='22023'; end if;
 if jsonb_array_length(_lines) not between 1 and 100 or length(v_notes)>1000 then raise exception 'Use 1-100 item lines and notes under 1001 characters' using errcode='22023'; end if;
 if exists(select 1 from jsonb_array_elements(_lines) l where jsonb_typeof(l) is distinct from 'object'
  or coalesce(l->>'item_id','') !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  or coalesce(l->>'quantity','') !~ '^[1-9][0-9]{0,5}$') then raise exception 'Every item needs a whole quantity between 1 and 999999' using errcode='22023'; end if;
 if (select count(distinct (l->>'item_id')::uuid) from jsonb_array_elements(_lines) l)<>jsonb_array_length(_lines) then raise exception 'Combine repeated items into one quantity' using errcode='22023'; end if;
 select jsonb_agg(jsonb_build_object('item_id',(l->>'item_id')::uuid,'quantity',(l->>'quantity')::integer) order by (l->>'item_id')::uuid)
 into _lines from jsonb_array_elements(_lines) l;
 v_payload := jsonb_build_object('location_id',_location_id,'lines',_lines,'notes',v_notes);
 perform pg_advisory_xact_lock(hashtextextended('receive:'||auth.uid()::text||_request_id::text,0));
 select * into v_prior from public.inventory_receiving_receipts where user_id=auth.uid() and request_id=_request_id;
 if found then
  if v_prior.payload<>v_payload then raise exception 'This request already saved a different inventory batch' using errcode='22023'; end if;
  return v_prior.result;
 end if;
 select * into v_location from public.locations where id=_location_id and active is true for update;
 if not found then raise exception 'Choose an active storage location' using errcode='22023'; end if;
 if not (coalesce(v_location.is_tray,false) or coalesce(v_location.location_role='tray',false) or coalesce(v_location.location_role='container',false) or v_location.parent_location_id is not null) then
  raise exception 'Choose a tray or a container inside storage' using errcode='22023';
 end if;
 if not(coalesce(v_location.is_tray,false) or coalesce(v_location.location_role='tray',false)) and v_location.parent_location_id is null then
  raise exception 'Containers must have a parent storage location' using errcode='22023';
 end if;
 if v_location.parent_location_id is not null then
  perform 1 from public.locations where id=v_location.parent_location_id and active is true for share;
  if not found then raise exception 'The parent storage location is inactive' using errcode='22023'; end if;
 end if;
 if coalesce(v_location.tray_current_store_id,v_location.store_id) is not null then
  perform 1 from public.store_locations where id=coalesce(v_location.tray_current_store_id,v_location.store_id) and active is true for share;
  if not found then raise exception 'The destination store is inactive' using errcode='22023'; end if;
 end if;
 select sum((l->>'quantity')::integer) into v_total from jsonb_array_elements(_lines) l;
 select coalesce(sum(quantity),0) into v_existing from public.item_stock_locations where location_id=_location_id and quantity>0;
 if v_location.max_capacity>0 and v_existing+v_total>v_location.max_capacity then raise exception 'This batch exceeds the destination capacity' using errcode='22023'; end if;
 select email into v_email from auth.users where id=auth.uid();
 -- Stable item ordering and row locks prevent lost increments and crossing batches from deadlocking.
 for v_line in select * from jsonb_to_recordset(_lines) as l(item_id uuid,quantity integer) order by item_id loop
  select title,barcode into v_title,v_barcode from public.item_types where id=v_line.item_id and deleted_at is null and deletion_status='active' for update;
  if not found then raise exception 'An item is missing or deleted. Review this batch' using errcode='22023'; end if;
  select id into v_stock_id from public.item_stock_locations where item_id=v_line.item_id and location_id=_location_id
   and condition_status='good' and batch_id is null order by id limit 1 for update;
  if found then
   update public.item_stock_locations set quantity=quantity+v_line.quantity,last_updated=now(),added_by=auth.uid(),confirmation_email=v_email,
    confirmation_method='password_inventory_batch',confirmed_at=now() where id=v_stock_id;
  else
   insert into public.item_stock_locations(item_id,location_id,quantity,added_by,confirmation_email,confirmation_method,condition_status)
   values(v_line.item_id,_location_id,v_line.quantity,auth.uid(),v_email,'password_inventory_batch','good') returning id into v_stock_id;
  end if;
  insert into public.stock_transactions(item_id,location_id,quantity,action_type,method,user_id,email,stock_condition,notes,metadata,destination_stock_location_row_id)
   values(v_line.item_id,_location_id,v_line.quantity,'checkin','password_inventory_batch',auth.uid(),v_email,'good',
    'Added via Add Inventory batch'||case when v_notes<>'' then ' | '||v_notes else '' end,
    jsonb_build_object('receiving_request_id',_request_id),v_stock_id) returning id into v_tx_id;
  select coalesce(sum(quantity),0) into v_after from public.item_stock_locations where item_id=v_line.item_id and location_id=_location_id and condition_status='good';
  v_results:=v_results||jsonb_build_array(jsonb_build_object('item_id',v_line.item_id,'title',v_title,'barcode',v_barcode,'quantity_added',v_line.quantity,'quantity_after',v_after,'transaction_id',v_tx_id));
 end loop;
 update public.metadata set inventory_version=gen_random_uuid()::text,changed_item_ids=array(select l->>'item_id' from jsonb_array_elements(_lines) l),updated_at=now() where id='inventory';
 v_result:=jsonb_build_object('request_id',_request_id,'location_id',_location_id,'location_name',v_location.location_name,'quantity_added',v_total,'lines',v_results,'saved_at',now());
 insert into public.inventory_receiving_receipts(user_id,request_id,payload,result) values(auth.uid(),_request_id,v_payload,v_result);
 return v_result;
end $$;
revoke all on function public.receive_inventory_batch(uuid,uuid,jsonb,text),public.get_inventory_receiving_receipt(uuid) from public,anon,authenticated;
grant execute on function public.receive_inventory_batch(uuid,uuid,jsonb,text),public.get_inventory_receiving_receipt(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
