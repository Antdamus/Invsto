begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Keep corrected work in the OG queue even when TikTok already says Shipped.
-- Marketplace status and original evidence are never rewritten by a reversal.
alter table public.tiktok_orders add column reopened_at timestamptz;

create function public.revert_tiktok_orders(_order_ids uuid[],_revisions jsonb,_reason text,_confirmed boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  o public.tiktok_orders; updated public.tiktok_orders; a record; src public.item_stock_locations;
  ids uuid[]; reason text:=btrim(coalesce(_reason,'')); signer record;
  before_links jsonb; before_lines jsonb; movements jsonb; tx uuid;
  order_units integer; total_units integer:=0; changed uuid[]:='{}';
begin
  if not public.can_revert_order_fulfillment() then
    raise exception 'Only active admins and managers can revert orders' using errcode='42501';
  end if;
  if _confirmed is distinct from true then raise exception 'Confirm the order is being reopened for correction' using errcode='22023';end if;
  if length(reason) not between 3 and 2000 then raise exception 'A reversal note is required (3 to 2000 characters)' using errcode='22023';end if;
  if coalesce(cardinality(_order_ids),0) not between 1 and 50 or array_position(_order_ids,null) is not null
    or jsonb_typeof(_revisions) is distinct from 'object' then raise exception 'Select 1 to 50 orders with their current revisions' using errcode='22023';end if;
  select array_agg(distinct v order by v) into ids from unnest(_order_ids) v;
  select e.display_name,e.role,u.email::text into signer from public.employees e join auth.users u on u.id=e.user_id where e.user_id=auth.uid();
  perform public.lock_shared_inventory();
  perform pg_advisory_xact_lock(hashtext('tiktok-orders'));
  perform 1 from public.tiktok_orders where id=any(ids) order by id for update;
  if (select count(*) from public.tiktok_orders where id=any(ids))<>cardinality(ids) then raise exception 'Order not found. Refresh before reverting.';end if;
  perform 1 from public.item_stock_locations where id in (
    select x.stock_row_id from public.tiktok_inventory_attachments x join public.tiktok_order_lines l on l.id=x.line_id where l.order_id=any(ids)
  ) order by id for update;

  for o in select * from public.tiktok_orders where id=any(ids) order by id loop
    if o.revision::text is distinct from _revisions->>o.id::text then raise exception 'This order changed. Refresh before reverting.' using errcode='40001';end if;
    if o.stage not in('completed','dispatched') then raise exception 'Only completed or dispatched OG work can be reverted. This order may already have been reverted.';end if;
    if o.marketplace_status not in('To ship','Shipped','Completed') or coalesce(o.cancel_return,'')<>'' then
      raise exception 'Resolve the TikTok cancellation, return or payment status before reopening this order.';
    end if;
    select coalesce(jsonb_agg(to_jsonb(l) order by l.id),'[]') into before_lines from public.tiktok_order_lines l where l.order_id=o.id;
    select coalesce(jsonb_agg(to_jsonb(x) order by x.line_id),'[]') into before_links from public.tiktok_inventory_attachments x
      join public.tiktok_order_lines l on l.id=x.line_id where l.order_id=o.id;
    movements:='[]';order_units:=0;
    for a in select x.* from public.tiktok_inventory_attachments x join public.tiktok_order_lines l on l.id=x.line_id
      where l.order_id=o.id and x.consumed_quantity>0 order by x.line_id for update of x loop
      select * into src from public.item_stock_locations where id=a.stock_row_id;
      if not found or src.item_id is distinct from a.item_id or src.condition_status is distinct from 'good' then
        raise exception 'The original inventory source changed. Ask an admin to review stock before reverting.';
      end if;
      update public.item_stock_locations set quantity=quantity+a.consumed_quantity,last_updated=now() where id=src.id;
      insert into public.stock_transactions(item_id,location_id,quantity,action_type,confirmed_at,user_id,email,notes,method,timestamp,source_stock_location_row_id,stock_condition,metadata)
      values(a.item_id,src.location_id,a.consumed_quantity,'correction',now(),auth.uid(),signer.email,
        'Reverted TikTok order '||o.order_number||': '||reason,'tiktok_order_reversal',now(),src.id,src.condition_status,
        jsonb_build_object('marketplace','tiktok','order_id',o.id,'order_number',o.order_number,'order_line_id',a.line_id,
          'before_quantity',src.quantity,'after_quantity',src.quantity+a.consumed_quantity,'batch_id',src.batch_id)) returning id into tx;
      movements:=movements||jsonb_build_array(jsonb_build_object('line_id',a.line_id,'stock_transaction_id',tx,'stock_row_id',src.id,
        'restored_units',a.consumed_quantity,'before_quantity',src.quantity,'after_quantity',src.quantity+a.consumed_quantity));
      update public.tiktok_inventory_attachments set consumed_quantity=0,revision=revision+1,updated_by=auth.uid(),updated_at=now() where line_id=a.line_id;
      order_units:=order_units+a.consumed_quantity;changed:=array_append(changed,a.item_id);
    end loop;
    update public.tiktok_orders set stage='pending',reopened_at=now(),revision=revision+1,updated_at=now() where id=o.id returning * into updated;
    insert into public.tiktok_order_events(order_id,actor,action,details) values(o.id,auth.uid(),'order_reverted',jsonb_build_object(
      'from',o.stage,'to','pending','notes',reason,'actor_email',signer.email,'actor_name',signer.display_name,'actor_role',signer.role,
      'restored_units',order_units,'before',to_jsonb(o),'after',to_jsonb(updated),'lines',before_lines,'inventory_before',before_links,'stock_movements',movements));
    total_units:=total_units+order_units;
  end loop;
  if total_units>0 then update public.metadata set inventory_version=gen_random_uuid()::text,
    changed_item_ids=array(select distinct v::text from unnest(changed) v),updated_at=now() where id='inventory';end if;
  return jsonb_build_object('reverted_orders',cardinality(ids),'restored_units',total_units);
end $$;

-- Staff preparation edits must use the dedicated reversal RPC for terminal work.
do $$ declare definition text; needle text; patched text; begin
  definition:=pg_get_functiondef('public.update_tiktok_order(uuid,integer,text,text,date,boolean)'::regprocedure);
  needle:='if o.stage in (''dispatched'',''completed'') and _stage<>o.stage and not(o.stage=''completed'' and _stage=''dispatched'') and nullif(trim(_notes),'''') is null then raise exception ''Record why the completed or dispatched order is being reopened'';end if;';
  patched:=replace(definition,needle,'if o.stage in (''dispatched'',''completed'') and _stage<>o.stage and not(o.stage=''completed'' and _stage=''dispatched'') then raise exception ''Use Revert order to reopen completed or dispatched work with an audit trail'';end if;');
  if patched=definition then raise exception 'Unrecognized TikTok preparation reopen check';end if;
  execute patched;
end $$;

create function public.clear_tiktok_reopened_at() returns trigger language plpgsql set search_path='' as $$
begin
  if new.stage in('completed','dispatched') and new.stage is distinct from old.stage then new.reopened_at:=null;end if;
  return new;
end $$;
create trigger clear_tiktok_reopened_at before update of stage on public.tiktok_orders for each row execute function public.clear_tiktok_reopened_at();
revoke all on function public.clear_tiktok_reopened_at(),public.revert_tiktok_orders(uuid[],jsonb,text,boolean) from public,anon,authenticated;
grant execute on function public.revert_tiktok_orders(uuid[],jsonb,text,boolean) to authenticated;
revoke insert,update,delete,truncate on public.tiktok_order_events from authenticated,anon;
notify pgrst,'reload schema';
commit;
