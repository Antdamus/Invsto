-- TikTok associations are drafts, not reservations. Final checkout rechecks shared stock.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
create table public.tiktok_inventory_attachments (
 line_id uuid primary key references public.tiktok_order_lines(id),
 item_id uuid not null references public.item_types(id),stock_row_id uuid not null references public.item_stock_locations(id),
 store_id uuid not null references public.store_locations(id),quantity integer not null check(quantity>=0),
 consumed_quantity integer not null default 0 check(consumed_quantity>=0 and consumed_quantity<=quantity),
 revision integer not null default 1,display_snapshot jsonb not null,
 updated_by uuid not null references auth.users(id),updated_at timestamptz not null default now()
);
alter table public.tiktok_inventory_attachments enable row level security;
revoke all on public.tiktok_inventory_attachments from public,anon,authenticated;
grant select on public.tiktok_inventory_attachments to authenticated;
create policy staff_read on public.tiktok_inventory_attachments for select to authenticated using(public.can_manage_inventory());

create function public.get_tiktok_inventory_stock(_item_id uuid,_store_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory staff access required' using errcode='42501';end if;
 if not exists(select 1 from public.store_locations where id=_store_id and active is true) then raise exception 'Choose an active checkout store';end if;
 select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) into result from (
  select s.id,s.item_id,s.location_id,s.batch_id,b.bag_barcode,l.location_name,l.location_code,p.location_name as parent_name,
   greatest(s.quantity-coalesce(a.reserved_quantity,0),0) as available,s.quantity as physical_quantity
  from public.item_stock_locations s join public.item_types i on i.id=s.item_id and i.deleted_at is null and i.deletion_status='active'
   join public.locations l on l.id=s.location_id left join public.locations p on p.id=l.parent_location_id
   left join public.bulk_batches b on b.id=s.batch_id left join public.active_stock_reservations a on a.stock_location_row_id=s.id
  where s.item_id=_item_id and s.condition_status='good' and s.quantity>0 and l.active is true
   and (l.parent_location_id is null or p.active is true)
   and (case when coalesce(l.is_tray,false) or l.location_role='tray'
    then coalesce(l.tray_status,'checked_in')<>'checked_out' and coalesce(l.tray_current_store_id,l.store_id)=_store_id
    else l.location_role in('storage_location','container') and coalesce(l.store_id,p.store_id)=_store_id end)
 ) r where r.available>0;
 return result;
end$$;

create function public.get_tiktok_inventory_editor(_line_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory staff access required' using errcode='42501';end if;
 select jsonb_build_object('line',to_jsonb(l),'order',to_jsonb(o),'attachment',to_jsonb(a),
  'stores',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name) order by name),'[]'::jsonb) from public.store_locations where active is true)) into result
 from public.tiktok_order_lines l join public.tiktok_orders o on o.id=l.order_id left join public.tiktok_inventory_attachments a on a.line_id=l.id where l.id=_line_id;
 if result is null then raise exception 'Refresh to load this TikTok order line';end if;return result;
end$$;

create function public.save_tiktok_inventory_attachment(_line_id uuid,_item_id uuid,_stock_row_id uuid,_store_id uuid,_quantity integer,_revision integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare l public.tiktok_order_lines;o public.tiktok_orders;a public.tiktok_inventory_attachments;stock jsonb;item public.item_types;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory staff access required' using errcode='42501';end if;
 perform public.lock_shared_inventory();perform pg_advisory_xact_lock(hashtext('tiktok-orders'));
 select * into l from public.tiktok_order_lines where id=_line_id for update;
 if not found then raise exception 'TikTok order line not found';end if;
 select * into o from public.tiktok_orders where id=l.order_id for update;
 if o.stage in('completed','dispatched') or o.marketplace_status not in('To ship','Shipped','Completed') or coalesce(o.cancel_return,'')<>'' then raise exception 'Only open TikTok orders can change inventory links';end if;
 select * into a from public.tiktok_inventory_attachments where line_id=l.id for update;
 -- Same desired value can safely recover a lost save response.
 if found and a.item_id=_item_id and a.stock_row_id=_stock_row_id and a.store_id=_store_id and a.quantity=_quantity and a.revision=_revision+1 then return to_jsonb(a);end if;
 if coalesce(a.revision,0) is distinct from _revision then raise exception 'Inventory link changed on another screen. Reopen it before saving.';end if;
 if _quantity is null or _quantity<coalesce(a.consumed_quantity,0) or _quantity>l.quantity then raise exception 'Quantity must be between the already deducted units and this order line quantity';end if;
 if coalesce(a.consumed_quantity,0)>0 and (a.item_id is distinct from _item_id or a.stock_row_id is distinct from _stock_row_id or a.store_id is distinct from _store_id) then raise exception 'This link already deducted stock. Its item and source cannot be replaced.';end if;
 if _quantity=0 then
  if a.line_id is null then return null;end if;
  update public.tiktok_inventory_attachments set quantity=0,revision=revision+1,updated_by=auth.uid(),updated_at=now() where line_id=l.id returning * into a;
 else
  select * into item from public.item_types where id=_item_id and deleted_at is null and deletion_status='active' for share;
  if not found then raise exception 'Inventory item is missing or inactive';end if;
  select r into stock from jsonb_array_elements(public.get_tiktok_inventory_stock(_item_id,_store_id)) r where r->>'id'=_stock_row_id::text;
  if _quantity-coalesce(a.consumed_quantity,0)>0 and (stock is null or (stock->>'available')::integer<_quantity-coalesce(a.consumed_quantity,0)) then raise exception 'Not enough unreserved stock at this store. Scan again.';end if;
  if not exists(select 1 from public.item_stock_locations where id=_stock_row_id and item_id=_item_id) then raise exception 'Choose the source containing this inventory item';end if;
  insert into public.tiktok_inventory_attachments(line_id,item_id,stock_row_id,store_id,quantity,display_snapshot,updated_by)
   values(l.id,_item_id,_stock_row_id,_store_id,_quantity,jsonb_build_object('title',item.title,'barcode',item.barcode,'location',stock->>'location_name','store',(select name from public.store_locations where id=_store_id)),auth.uid())
   on conflict(line_id) do update set item_id=excluded.item_id,stock_row_id=excluded.stock_row_id,store_id=excluded.store_id,quantity=excluded.quantity,
    display_snapshot=case when stock is null then tiktok_inventory_attachments.display_snapshot else excluded.display_snapshot end,revision=tiktok_inventory_attachments.revision+1,updated_by=auth.uid(),updated_at=now() returning * into a;
 end if;
 update public.tiktok_orders set revision=revision+1,updated_at=now() where id=o.id;
 insert into public.tiktok_order_events(order_id,actor,action,details) values(o.id,auth.uid(),'inventory_link_updated',jsonb_build_object('line_id',l.id,'attachment',to_jsonb(a),'stock_deducted',false));
 return to_jsonb(a);
end$$;

-- The evidence function is private; only the atomic stock-aware wrapper is callable.
alter function public.complete_tiktok_orders(uuid[],jsonb,boolean) rename to complete_tiktok_orders_evidence;
revoke all on function public.complete_tiktok_orders_evidence(uuid[],jsonb,boolean) from public,anon,authenticated;
create function public.complete_tiktok_orders(_order_ids uuid[],_revisions jsonb,_confirmed boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;ids uuid[];a record;src public.item_stock_locations;available integer;delta integer;tx uuid;total integer=0;changed uuid[]='{}';
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory staff access required' using errcode='42501';end if;
 perform public.lock_shared_inventory();perform pg_advisory_xact_lock(hashtext('tiktok-orders'));
 select array_agg(id order by id) into ids from public.tiktok_orders where id=any(_order_ids) and stage<>'completed';
 -- Lock sources and location/store/item eligibility while checking every linked line.
 perform 1 from public.item_stock_locations where id in(select x.stock_row_id from public.tiktok_inventory_attachments x join public.tiktok_order_lines l on l.id=x.line_id where l.order_id=any(ids)) order by id for update;
 perform 1 from public.locations where id in(select s.location_id from public.item_stock_locations s join public.tiktok_inventory_attachments x on x.stock_row_id=s.id join public.tiktok_order_lines l on l.id=x.line_id where l.order_id=any(ids)) order by id for share;
 perform 1 from public.locations where id in(select z.parent_location_id from public.locations z join public.item_stock_locations s on s.location_id=z.id join public.tiktok_inventory_attachments x on x.stock_row_id=s.id join public.tiktok_order_lines l on l.id=x.line_id where l.order_id=any(ids)) order by id for share;
 perform 1 from public.store_locations where id in(select x.store_id from public.tiktok_inventory_attachments x join public.tiktok_order_lines l on l.id=x.line_id where l.order_id=any(ids)) order by id for share;
 perform 1 from public.item_types where id in(select x.item_id from public.tiktok_inventory_attachments x join public.tiktok_order_lines l on l.id=x.line_id where l.order_id=any(ids)) order by id for share;
 for a in select x.*,l.quantity as ordered_quantity,l.order_id,o.order_number from public.tiktok_inventory_attachments x join public.tiktok_order_lines l on l.id=x.line_id join public.tiktok_orders o on o.id=l.order_id where o.id=any(ids) order by x.line_id loop
  if a.quantity>a.ordered_quantity then raise exception 'Linked inventory exceeds the current order quantity. Review the inventory link.';end if;
  delta=a.quantity-a.consumed_quantity;if delta=0 then continue;end if;
  select * into src from public.item_stock_locations where id=a.stock_row_id;
  select (r->>'available')::integer into available from jsonb_array_elements(public.get_tiktok_inventory_stock(a.item_id,a.store_id)) r where r->>'id'=a.stock_row_id::text;
  if available is null or available<delta then raise exception 'Linked inventory is no longer available for TikTok order %. Review its inventory link.',a.order_number;end if;
  update public.item_stock_locations set quantity=quantity-delta,last_updated=now() where id=src.id;
  insert into public.stock_transactions(item_id,location_id,quantity,action_type,confirmed_at,user_id,email,notes,method,timestamp,source_stock_location_row_id,stock_condition,metadata)
   values(a.item_id,src.location_id,-delta,'checkout',now(),auth.uid(),auth.email(),'TikTok order '||a.order_number,'tiktok_order_completion',now(),src.id,'good',jsonb_build_object('marketplace','tiktok','order_id',a.order_id,'order_number',a.order_number,'order_line_id',a.line_id,'checkout_store_id',a.store_id,'batch_id',src.batch_id)) returning id into tx;
  update public.tiktok_inventory_attachments set consumed_quantity=quantity,revision=revision+1,updated_at=now(),updated_by=auth.uid() where line_id=a.line_id;
  insert into public.tiktok_order_events(order_id,actor,action,details) values(a.order_id,auth.uid(),'inventory_deducted',jsonb_build_object('line_id',a.line_id,'item_id',a.item_id,'quantity',delta,'stock_transaction_id',tx,'source_stock_row_id',src.id,'remaining_stock',src.quantity-delta));
  total=total+delta;changed=array_append(changed,a.item_id);
 end loop;
 -- Any evidence/revision/cancellation failure rolls back all stock movements too.
 result=public.complete_tiktok_orders_evidence(_order_ids,_revisions,_confirmed);
 if total>0 then update public.metadata set inventory_version=gen_random_uuid()::text,changed_item_ids=array(select distinct v::text from unnest(changed) v),updated_at=now() where id='inventory';end if;
 return result||jsonb_build_object('inventory_units_deducted',total);
end$$;

create function public.guard_tiktok_inventory_dispatch() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.stage='dispatched' and new.stage is distinct from old.stage and exists(select 1 from public.tiktok_inventory_attachments x join public.tiktok_order_lines l on l.id=x.line_id where l.order_id=new.id and x.quantity>x.consumed_quantity) then raise exception 'Use Complete order to deduct the linked inventory before confirming dispatch';end if;return new;
end$$;
create trigger tiktok_inventory_dispatch before update of stage on public.tiktok_orders for each row execute function public.guard_tiktok_inventory_dispatch();
revoke all on function public.get_tiktok_inventory_stock(uuid,uuid),public.get_tiktok_inventory_editor(uuid),public.save_tiktok_inventory_attachment(uuid,uuid,uuid,uuid,integer,integer),public.complete_tiktok_orders(uuid[],jsonb,boolean),public.guard_tiktok_inventory_dispatch() from public,anon,authenticated;
grant execute on function public.get_tiktok_inventory_stock(uuid,uuid),public.get_tiktok_inventory_editor(uuid),public.save_tiktok_inventory_attachment(uuid,uuid,uuid,uuid,integer,integer),public.complete_tiktok_orders(uuid[],jsonb,boolean) to authenticated;
notify pgrst,'reload schema';
commit;
