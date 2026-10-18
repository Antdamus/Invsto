begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

alter table public.tiktok_order_lines add column fulfilled_at timestamptz;
alter table public.tiktok_order_lines add column fulfilled_by uuid references auth.users(id);
update public.tiktok_order_lines l set fulfilled_at=o.updated_at from public.tiktok_orders o
 where o.id=l.order_id and o.stage in('completed','dispatched');

-- Keep older clients compatible and protect outstanding lines from manual dispatch.
create or replace function public.guard_tiktok_work_stage() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.stage in('completed','dispatched') and new.stage is distinct from old.stage
  and exists(select 1 from public.tiktok_order_lines where order_id=new.id and fulfilled_at is not null)
  and exists(select 1 from public.tiktok_order_lines where order_id=new.id and fulfilled_at is null)
 then raise exception 'Complete the remaining order items before dispatching this order';end if;
 if new.stage='completed' and exists(select 1 from public.tiktok_order_lines where order_id=new.id)
  and not exists(select 1 from public.tiktok_order_lines where order_id=new.id and fulfilled_at is null) then return new;end if;
 if new.stage in('packed','completed','dispatched') and new.stage is distinct from old.stage and old.stage<>'completed'
 then perform public.assert_tiktok_work_ready(array[new.id]);end if;
 return new;
end$$;
create function public.tiktok_legacy_line_completion() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.stage in('completed','dispatched') and new.stage is distinct from old.stage then
  update public.tiktok_order_lines set fulfilled_at=now(),fulfilled_by=auth.uid() where order_id=new.id and fulfilled_at is null;
 end if;return new;
end$$;
create trigger tiktok_legacy_line_completion after update of stage on public.tiktok_orders for each row execute function public.tiktok_legacy_line_completion();

-- Completed lines stay read-only until a manager's audited reversal.
do $$
declare def text;
begin
 select pg_get_functiondef('public.add_tiktok_order_completion_photos(uuid,uuid[],jsonb,text,text,text,jsonb)'::regprocedure) into def;
 if position('where order_id=_order_id;' in def)=0 then raise exception 'Missing photo scope query';end if;
 execute replace(def,'where order_id=_order_id;', 'where order_id=_order_id and id=any(ids);');
 select pg_get_functiondef('public.complete_tiktok_orders_evidence(uuid[],jsonb,boolean)'::regprocedure) into def;
 if position('update public.tiktok_orders set stage=''completed''' in def)=0 then raise exception 'Missing completion update';end if;
 execute replace(def,'update public.tiktok_orders set stage=''completed''',
  'update public.tiktok_order_lines set fulfilled_at=now(),fulfilled_by=auth.uid() where order_id=o.id and fulfilled_at is null; update public.tiktok_orders set stage=''completed''');
 select pg_get_functiondef('public.save_tiktok_line_work(uuid,integer,text,text,boolean,uuid)'::regprocedure) into def;
 if position('if o.stage in(' in def)=0 then raise exception 'Missing work guard';end if;
 execute replace(def,'if o.stage in(', 'if l.fulfilled_at is not null or o.stage in(');
 select pg_get_functiondef('public.save_tiktok_inventory_attachment(uuid,uuid,uuid,uuid,integer,integer)'::regprocedure) into def;
 if position('if o.stage in(' in def)=0 then raise exception 'Missing inventory guard';end if;
 execute replace(def,'if o.stage in(', 'if l.fulfilled_at is not null or o.stage in(');
 select pg_get_functiondef('public.revert_tiktok_orders(uuid[],jsonb,text,boolean)'::regprocedure) into def;
 if position('if o.stage not in(''completed'',''dispatched'') then' in def)=0 then raise exception 'Missing reversal guard';end if;
 def:=replace(def,'if o.stage not in(''completed'',''dispatched'') then',
  'if o.stage not in(''completed'',''dispatched'') and not exists(select 1 from public.tiktok_order_lines where order_id=o.id and fulfilled_at is not null) then');
 if position('update public.tiktok_orders set stage=''pending''' in def)=0 then raise exception 'Missing reversal update';end if;
 execute replace(def,'update public.tiktok_orders set stage=''pending''',
  'update public.tiktok_order_lines set fulfilled_at=null,fulfilled_by=null where order_id=o.id; update public.tiktok_orders set stage=''pending''');
end$$;

-- A changed quantity or new line must be reviewed again, even after a marketplace shipment.
create function public.tiktok_changed_line_completion() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='UPDATE' then
  if old.fulfilled_at is null or (new.quantity=old.quantity and new.sku_id=old.sku_id) then return new;end if;
  new.fulfilled_at=null;new.fulfilled_by=null;
 elsif exists(select 1 from public.tiktok_order_lines where order_id=new.order_id and sku_id=new.sku_id)
  or not exists(select 1 from public.tiktok_order_lines where order_id=new.order_id and fulfilled_at is not null) then return new;
 end if;
 update public.tiktok_orders set stage='waiting',reopened_at=now(),revision=revision+1,updated_at=now() where id=new.order_id;
 insert into public.tiktok_order_events(order_id,actor,action,details) values(new.order_id,auth.uid(),'completion_items_changed',
  jsonb_build_object('line_id',new.id,'notes','Imported items changed; review the outstanding items before completing.','quantity',new.quantity));
 return new;
end$$;
create trigger tiktok_changed_line_completion before insert or update of quantity,sku_id on public.tiktok_order_lines for each row execute function public.tiktok_changed_line_completion();

create function public.complete_tiktok_order_lines_review(_line_ids uuid[],_revisions jsonb,_confirmed boolean,_note text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 ids uuid[]; order_ids uuid[]; o public.tiktok_orders; l record; a record; src public.item_stock_locations;
 scope jsonb; label_ids jsonb; proof_ids uuid[]; available integer; delta integer; tx uuid;
 total integer:=0; completed integer:=0; changed uuid[]:='{}'; note text:=nullif(btrim(coalesce(_note,'')),'');
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory staff access required' using errcode='42501';end if;
 if _confirmed is distinct from true then raise exception 'Confirm the selected items and labels before completing';end if;
 if coalesce(cardinality(_line_ids),0) not between 1 and 500 or array_position(_line_ids,null) is not null
  or jsonb_typeof(_revisions) is distinct from 'object' then raise exception 'Select 1 to 500 order items with their current revisions';end if;
 if length(coalesce(_note,''))>4000 then raise exception 'Completion notes must be 4,000 characters or fewer';end if;
 perform public.lock_shared_inventory();perform pg_advisory_xact_lock(hashtext('tiktok-orders'));
 select array_agg(distinct id order by id) into ids from unnest(_line_ids) id;
 if (select count(*) from public.tiktok_order_lines where id=any(ids))<>cardinality(ids) then raise exception 'Order item not found. Refresh before completing.';end if;
 -- A retry after a committed response cannot deduct inventory or append notes twice.
 select array_agg(id order by id) into ids from public.tiktok_order_lines where id=any(ids) and fulfilled_at is null;
 if ids is null then return jsonb_build_object('completed',0,'completed_lines',0,'inventory_units_deducted',0);end if;
 select array_agg(distinct order_id order by order_id) into order_ids from public.tiktok_order_lines where id=any(ids);
 perform 1 from public.tiktok_orders where id=any(order_ids) order by id for update;
 for o in select * from public.tiktok_orders where id=any(order_ids) order by id loop
  if o.revision::text is distinct from _revisions->>o.id::text then raise exception 'This order changed. Refresh and review the selected items.' using errcode='40001';end if;
  if o.stage in('completed','dispatched') or o.marketplace_status not in('To ship','Shipped','Completed') or coalesce(o.cancel_return,'')<>'' then raise exception 'Resolve the cancellation or payment status before completing this order';end if;
  if exists(select 1 from public.tiktok_order_cancellations where order_id=o.id and pending) then raise exception 'Resolve pending cancellation before completing this order';end if;
  if not exists(select 1 from public.tiktok_order_documents where order_id=o.id and kind='label') then raise exception 'Save the shipping label for every selected order first';end if;
 end loop;
 for l in select x.*,w.item_search,w.watch_missing,w.cgl_required,w.certificate_id from public.tiktok_order_lines x left join public.tiktok_line_work w on w.line_id=x.id where x.id=any(ids) loop
  if l.item_search='not_found' or l.watch_missing or (l.cgl_required and not exists(select 1 from public.tiktok_order_line_certificates where id=l.certificate_id and order_line_id=l.id and voided_at is null)) then raise exception 'A selected item is lost, missing or waiting for CGL. Refresh and review the selection.';end if;
  if not exists(select 1 from public.tiktok_order_completion_photos p where p.order_id=l.order_id
   and p.payload->>'proof_type'='completion_photo' and coalesce(p.payload->>'history_removed','false')<>'true'
   and p.payload->'item_scope' @> jsonb_build_array(jsonb_build_object('id',l.id,'sku_id',l.sku_id,'quantity',l.quantity))
   and jsonb_array_length(p.photo_attachments)>0) then raise exception 'Save a completion photo covering each selected item and its current quantity first';end if;
 end loop;
 -- Match the shared-inventory locking order used by full-order checkout.
 perform 1 from public.item_stock_locations where id in(select stock_row_id from public.tiktok_inventory_attachments where line_id=any(ids)) order by id for update;
 perform 1 from public.locations where id in(select s.location_id from public.item_stock_locations s join public.tiktok_inventory_attachments x on x.stock_row_id=s.id where x.line_id=any(ids)) order by id for share;
 perform 1 from public.locations where id in(select z.parent_location_id from public.locations z join public.item_stock_locations s on s.location_id=z.id join public.tiktok_inventory_attachments x on x.stock_row_id=s.id where x.line_id=any(ids)) order by id for share;
 perform 1 from public.store_locations where id in(select store_id from public.tiktok_inventory_attachments where line_id=any(ids)) order by id for share;
 perform 1 from public.item_types where id in(select item_id from public.tiktok_inventory_attachments where line_id=any(ids)) order by id for share;
 for a in select x.*,ol.quantity as ordered_quantity,ol.order_id,ord.order_number from public.tiktok_inventory_attachments x join public.tiktok_order_lines ol on ol.id=x.line_id join public.tiktok_orders ord on ord.id=ol.order_id where ol.id=any(ids) order by x.line_id loop
  if a.quantity>a.ordered_quantity then raise exception 'Linked inventory exceeds the current order quantity. Review the inventory link.';end if;
  delta:=a.quantity-a.consumed_quantity;if delta=0 then continue;end if;
  select * into src from public.item_stock_locations where id=a.stock_row_id;
  select (r->>'available')::integer into available from jsonb_array_elements(public.get_tiktok_inventory_stock(a.item_id,a.store_id)) r where r->>'id'=a.stock_row_id::text;
  if available is null or available<delta then raise exception 'Linked inventory is no longer available. Review its inventory link.';end if;
  update public.item_stock_locations set quantity=quantity-delta,last_updated=now() where id=src.id;
  insert into public.stock_transactions(item_id,location_id,quantity,action_type,confirmed_at,user_id,email,notes,method,timestamp,source_stock_location_row_id,stock_condition,metadata)
   values(a.item_id,src.location_id,-delta,'checkout',now(),auth.uid(),auth.email(),'TikTok order '||a.order_number,'tiktok_order_completion',now(),src.id,'good',jsonb_build_object('marketplace','tiktok','order_id',a.order_id,'order_number',a.order_number,'order_line_id',a.line_id,'checkout_store_id',a.store_id,'batch_id',src.batch_id)) returning id into tx;
  update public.tiktok_inventory_attachments set consumed_quantity=quantity,revision=revision+1,updated_at=now(),updated_by=auth.uid() where line_id=a.line_id;
  insert into public.tiktok_order_events(order_id,actor,action,details) values(a.order_id,auth.uid(),'inventory_deducted',jsonb_build_object('line_id',a.line_id,'item_id',a.item_id,'quantity',delta,'stock_transaction_id',tx,'source_stock_row_id',src.id,'remaining_stock',src.quantity-delta));
  total:=total+delta;changed:=array_append(changed,a.item_id);
 end loop;
 update public.tiktok_order_lines set fulfilled_at=now(),fulfilled_by=auth.uid() where id=any(ids);
 for o in select * from public.tiktok_orders where id=any(order_ids) order by id loop
  select jsonb_agg(jsonb_build_object('line_id',id,'sku_id',sku_id,'quantity',quantity) order by id) into scope from public.tiktok_order_lines where order_id=o.id and id=any(ids);
  select jsonb_agg(id order by id) into label_ids from public.tiktok_order_documents where order_id=o.id and kind='label';
  select array_agg(p.id order by p.id) into proof_ids from public.tiktok_order_completion_photos p where p.order_id=o.id
   and coalesce(p.payload->>'history_removed','false')<>'true' and jsonb_array_length(p.photo_attachments)>0
   and exists(select 1 from public.tiktok_order_lines x where x.order_id=o.id and x.id=any(ids)
    and p.payload->'item_scope' @> jsonb_build_array(jsonb_build_object('id',x.id,'sku_id',x.sku_id,'quantity',x.quantity)));
  if not exists(select 1 from public.tiktok_order_lines where order_id=o.id and fulfilled_at is null) then
   update public.tiktok_orders set stage='completed',revision=revision+1,updated_at=now() where id=o.id;completed:=completed+1;
   insert into public.tiktok_order_events(order_id,actor,action,details) values(o.id,auth.uid(),'order_completed',jsonb_build_object('from',o.stage,'to','completed','selected_line_ids',ids));
  else
   update public.tiktok_orders set stage='preparing',reopened_at=coalesce(reopened_at,now()),revision=revision+1,updated_at=now() where id=o.id;
  end if;
  insert into public.tiktok_order_events(order_id,actor,action,details) values(o.id,auth.uid(),'completion_review',jsonb_build_object(
   'notes',note,'actor_email',auth.email(),'confirmed',true,'selected_order_ids',order_ids,'selected_line_ids',ids,
   'items',scope,'label_document_ids',label_ids,'completion_photo_ids',proof_ids,
   'remaining_line_ids',array(select id from public.tiktok_order_lines where order_id=o.id and fulfilled_at is null order by id)));
 end loop;
 if total>0 then update public.metadata set inventory_version=gen_random_uuid()::text,changed_item_ids=array(select distinct v::text from unnest(changed) v),updated_at=now() where id='inventory';end if;
 return jsonb_build_object('completed',completed,'completed_lines',cardinality(ids),'inventory_units_deducted',total);
end$$;
revoke all on function public.tiktok_legacy_line_completion(),public.tiktok_changed_line_completion(),public.complete_tiktok_order_lines_review(uuid[],jsonb,boolean,text) from public,anon,authenticated;
grant execute on function public.complete_tiktok_order_lines_review(uuid[],jsonb,boolean,text) to authenticated;
notify pgrst,'reload schema';
commit;
