begin;

-- Stock rows are the authoritative remaining count. The old trigger referenced
-- qty_remaining/status/low_threshold/initial_qty, none of which exist on bags.
create or replace function public.sync_batch_qty_from_stock() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_old uuid; v_new uuid; v_remaining bigint;
begin
 if TG_OP <> 'INSERT' then v_old:=OLD.batch_id; end if;
 if TG_OP <> 'DELETE' then v_new:=NEW.batch_id; end if;
 for v_id in select distinct id from unnest(array[v_old,v_new]) id where id is not null order by id loop
  perform 1 from public.bulk_batches where id=v_id for update;
  if found then
   select coalesce(sum(greatest(quantity,0)),0) into v_remaining from public.item_stock_locations where batch_id=v_id;
   update public.bulk_batches set retired_at=case when v_remaining=0 then coalesce(retired_at,now()) else null end where id=v_id;
  end if;
 end loop;
 return null;
end $$;
drop trigger if exists trg_sync_batch_qty_from_stock on public.item_stock_locations;
create trigger trg_sync_batch_qty_from_stock after insert or delete or update of quantity,batch_id on public.item_stock_locations
for each row execute function public.sync_batch_qty_from_stock();
revoke all on function public.sync_batch_qty_from_stock() from public,anon,authenticated;

create table public.bulk_receiving_receipts (
 bag_barcode text primary key, user_id uuid not null references auth.users(id),
 payload jsonb not null, result jsonb not null, created_at timestamptz not null default now()
);
alter table public.bulk_receiving_receipts enable row level security;
revoke all on public.bulk_receiving_receipts from public,anon,authenticated;

create function public.receive_bulk_bag(_item_id uuid,_bag_barcode text,_location_id uuid,_payload jsonb,
 _bag_label_url text default null,_bag_photo_url text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 v_bag public.bulk_batches; v_prior public.bulk_receiving_receipts; v_location public.locations;
 v_payload jsonb; v_result jsonb; v_email text; v_stock uuid; v_tx uuid; v_existing bigint;
 v_tare numeric(12,4); v_gross numeric(12,4); v_unit numeric(10,4); v_override numeric(10,4);
 v_samples numeric[]; v_average numeric(10,4); v_qty integer; v_source text; v_notes text;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501'; end if;
 if _item_id is null or coalesce(_bag_barcode,'') !~ '^BAG-[A-Z0-9-]{5,80}$' then raise exception 'Valid item and captured bag barcode required' using errcode='22023'; end if;
 if jsonb_typeof(_payload) is distinct from 'object' then raise exception 'Bag measurements required' using errcode='22023'; end if;
 if exists(select 1 from jsonb_each_text(_payload) p where p.key in ('tare_weight_g','gross_weight_g','unit_weight_g','unit_override_g','sample_w1_g','sample_w2_g','sample_w3_g','sample_w4_g','sample_w5_g')
  and p.value is not null and p.value !~ '^[0-9]+([.][0-9]{1,4})?$') then raise exception 'Use nonnegative weights with up to four decimal places' using errcode='22023'; end if;
 v_tare:=(_payload->>'tare_weight_g')::numeric; v_gross:=(_payload->>'gross_weight_g')::numeric;
 v_unit:=(_payload->>'unit_weight_g')::numeric; v_override:=(_payload->>'unit_override_g')::numeric;
 v_source:=_payload->>'unit_source'; v_notes:=nullif(btrim(_payload->>'notes'),'');
 v_samples:=array[(_payload->>'sample_w1_g')::numeric,(_payload->>'sample_w2_g')::numeric,(_payload->>'sample_w3_g')::numeric,(_payload->>'sample_w4_g')::numeric,(_payload->>'sample_w5_g')::numeric];
 if v_tare is null or v_gross is null or v_unit is null or v_tare<0 or v_gross<=v_tare or v_unit<=0 or v_source is null or v_source not in ('override','samples') then raise exception 'Check the bag tare, gross and unit weights' using errcode='22023'; end if;
 if v_source='override' then
  if v_override is null or v_override<>v_unit then raise exception 'Unit weight must match its override' using errcode='22023'; end if;
 else
  select case when count(*)>=3 then round(avg(w),4) end into v_average from unnest(v_samples) w where w>0;
  if v_average is null or v_average<>v_unit then raise exception 'Use at least three samples matching the unit weight' using errcode='22023'; end if;
 end if;
 v_qty:=floor((v_gross-v_tare)/v_unit);
 if v_qty not between 1 and 999999 or coalesce(_payload->>'estimated_qty','') !~ '^[1-9][0-9]{0,5}$' then raise exception 'Bag must contain 1-999999 estimated units' using errcode='22023'; end if;
 if (_payload->>'estimated_qty')::integer<>v_qty then raise exception 'Bag quantity does not match its weights' using errcode='22023'; end if;
 if length(v_notes)>1000 or length(_bag_label_url)>1000 or length(_bag_photo_url)>1000 then raise exception 'Bag note or attachment path is too long' using errcode='22023'; end if;
 v_payload:=jsonb_build_object('item_id',_item_id,'location_id',_location_id,'tare',v_tare,'gross',v_gross,'unit',v_unit,'override',v_override,'source',v_source,'samples',v_samples,'quantity',v_qty,'notes',v_notes);
 perform pg_advisory_xact_lock(hashtextextended('bulk-receive:'||_bag_barcode,0));
 select * into v_prior from public.bulk_receiving_receipts where bag_barcode=_bag_barcode;
 if found then
  if v_prior.user_id<>auth.uid() or v_prior.payload<>v_payload then raise exception 'This bag barcode already belongs to a different saved bag' using errcode='22023'; end if;
  return v_prior.result;
 end if;
 if exists(select 1 from public.bulk_batches where bag_barcode=_bag_barcode) then raise exception 'This bag barcode is already registered. Check Stock before adding it again' using errcode='22023'; end if;
 if _location_id is not null then
  select * into v_location from public.locations where id=_location_id and active is true for update;
  if not found then raise exception 'Choose an active storage location' using errcode='22023'; end if;
  if not(coalesce(v_location.is_tray,false) or coalesce(v_location.location_role='tray',false)) and v_location.parent_location_id is null then raise exception 'Choose a tray or a container inside storage' using errcode='22023'; end if;
  if v_location.parent_location_id is not null then
   perform 1 from public.locations where id=v_location.parent_location_id and active is true for share;
   if not found then raise exception 'The parent storage location is inactive' using errcode='22023'; end if;
  end if;
  if coalesce(v_location.tray_current_store_id,v_location.store_id) is not null then
   perform 1 from public.store_locations where id=coalesce(v_location.tray_current_store_id,v_location.store_id) and active is true for share;
   if not found then raise exception 'The destination store is inactive' using errcode='22023'; end if;
  end if;
  select coalesce(sum(quantity),0) into v_existing from public.item_stock_locations where location_id=_location_id and quantity>0;
  if v_location.max_capacity>0 and v_existing+v_qty>v_location.max_capacity then raise exception 'This bag exceeds the destination capacity' using errcode='22023'; end if;
 end if;
 perform 1 from public.item_types where id=_item_id and deleted_at is null and deletion_status='active' for update;
 if not found then raise exception 'Item is missing or deleted' using errcode='22023'; end if;
 select email into v_email from auth.users where id=auth.uid();
 insert into public.bulk_batches(item_type_id,bag_barcode,location_id,tare_weight_g,gross_weight_g,unit_weight_g,unit_override_g,unit_source,
  sample_w1_g,sample_w2_g,sample_w3_g,sample_w4_g,sample_w5_g,estimated_qty,notes,created_by,bag_label_url,bag_photo_url)
 values(_item_id,_bag_barcode,_location_id,v_tare,v_gross,v_unit,v_override,v_source,v_samples[1],v_samples[2],v_samples[3],v_samples[4],v_samples[5],v_qty,v_notes,auth.uid(),_bag_label_url,_bag_photo_url) returning * into v_bag;
 if _location_id is not null then
  insert into public.item_stock_locations(item_id,location_id,batch_id,quantity,added_by,confirmation_email,confirmation_method,condition_status)
  values(_item_id,_location_id,v_bag.id,v_qty,auth.uid(),v_email,'password_bulk_bag','good') returning id into v_stock;
  insert into public.stock_transactions(item_id,location_id,quantity,action_type,method,user_id,email,stock_condition,notes,metadata,destination_stock_location_row_id)
  values(_item_id,_location_id,v_qty,'checkin','bulk_bag',auth.uid(),v_email,'good','Added via Bulk Bag '||_bag_barcode,
   jsonb_build_object('batch_id',v_bag.id,'bag_barcode',_bag_barcode),v_stock) returning id into v_tx;
  update public.metadata set inventory_version=gen_random_uuid()::text,changed_item_ids=array[_item_id::text],updated_at=now() where id='inventory';
 end if;
 v_result:=jsonb_build_object('bag',to_jsonb(v_bag),'stock_location_id',v_stock,'transaction_id',v_tx,'quantity_added',case when _location_id is null then 0 else v_qty end);
 insert into public.bulk_receiving_receipts(bag_barcode,user_id,payload,result) values(_bag_barcode,auth.uid(),v_payload,v_result);
 return v_result;
end $$;
revoke all on function public.receive_bulk_bag(uuid,text,uuid,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.receive_bulk_bag(uuid,text,uuid,jsonb,text,text) to authenticated;
notify pgrst,'reload schema';
commit;
