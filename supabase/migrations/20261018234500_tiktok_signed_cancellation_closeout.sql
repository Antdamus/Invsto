begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

alter table public.tiktok_orders add column cancellation_signed_at timestamptz;
alter table public.tiktok_order_lines add column cancellation_signed_at timestamptz;

-- Signing closes OG work; it never submits a marketplace refund or changes stock.
create function public.sign_tiktok_cancellations(_order_ids uuid[],_line_ids uuid[],_revisions jsonb,_note text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare order_ids uuid[];line_ids uuid[];affected uuid[];o public.tiktok_orders;l public.tiktok_order_lines;before_order jsonb;scope uuid[];reason text:=coalesce(nullif(btrim(_note),''),'Cancellation verified in TikTok');changed integer:=0;
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory staff access required' using errcode='42501';end if;
 if coalesce(cardinality(_order_ids),0)+coalesce(cardinality(_line_ids),0) not between 1 and 500 or array_position(_order_ids,null) is not null or array_position(_line_ids,null) is not null or jsonb_typeof(_revisions) is distinct from 'object' then raise exception 'Select the orders or items to cancel';end if;
 if length(reason) not between 3 and 2000 then raise exception 'Use 3 to 2000 characters for the note';end if;
 perform pg_advisory_xact_lock(hashtext('tiktok-orders'));
 select coalesce(array_agg(distinct id),'{}') into order_ids from unnest(_order_ids) id;
 select coalesce(array_agg(distinct id),'{}') into line_ids from unnest(_line_ids) id;
 if (select count(*) from public.tiktok_orders where id=any(order_ids))<>cardinality(order_ids) or (select count(*) from public.tiktok_order_lines where id=any(line_ids))<>cardinality(line_ids) then raise exception 'Order or item not found';end if;
 select array_agg(distinct id) into affected from (select unnest(order_ids) id union select order_id from public.tiktok_order_lines where id=any(line_ids)) ids;
 if (select count(distinct lower(buyer_username)) from public.tiktok_orders where id=any(affected))<>1 then raise exception 'Select orders belonging to one buyer';end if;
 for o in select * from public.tiktok_orders where id=any(affected) order by id for update loop
  before_order:=to_jsonb(o);
  if o.id=any(order_ids) then
   if o.cancellation_signed_at is not null and o.marketplace_status in('Canceled','Cancelled') and not exists(select 1 from public.tiktok_order_lines where order_id=o.id and cancellation_signed_at is null) then continue;end if;
   select array_agg(id order by id) into scope from public.tiktok_order_lines where order_id=o.id;
  else
   select array_agg(id order by id) into scope from public.tiktok_order_lines where order_id=o.id and id=any(line_ids) and cancellation_signed_at is null;
   if scope is null then continue;end if;
  end if;
  if o.revision::text is distinct from _revisions->>o.id::text then raise exception 'This order changed. Refresh and review it before signing.' using errcode='40001';end if;
  if o.id=any(order_ids) then
   if o.marketplace_status not in('Canceled','Cancelled') then perform public.record_tiktok_cancellation(o.id,o.revision,true,reason,true);end if;
   update public.tiktok_orders set cancellation_signed_at=now(),revision=revision+1,updated_at=now() where id=o.id;
   update public.tiktok_order_cancellations set pending=false,revision=revision+1,updated_by=auth.uid(),updated_at=now() where order_id=o.id and pending;
  else
   for l in select * from public.tiktok_order_lines where id=any(scope) order by id loop
    if l.cancelled_at is null and o.marketplace_status not in('Canceled','Cancelled') then
     perform public.record_tiktok_line_cancellation(l.id,(select revision from public.tiktok_orders where id=o.id),true,reason,true);
    end if;
   end loop;
   update public.tiktok_orders set revision=revision+1,updated_at=now() where id=o.id;
  end if;
  update public.tiktok_order_lines set cancellation_signed_at=now() where id=any(scope);
  insert into public.tiktok_order_events(order_id,actor,action,details) values(o.id,auth.uid(),'cancellation_signed',jsonb_build_object('actor_email',auth.email(),'signed_at',now(),'notes',reason,'scope',case when o.id=any(order_ids) then 'order' else 'items' end,'line_ids',scope,'items',(select jsonb_agg(jsonb_build_object('line_id',id,'sku_id',sku_id,'quantity',quantity)) from public.tiktok_order_lines where id=any(scope)),'before',before_order,'after',(select to_jsonb(x) from public.tiktok_orders x where id=o.id),'inventory_changed',false));
  changed:=changed+1;
 end loop;
 return jsonb_build_object('signed_orders',changed);
end$$;

-- Corrected cancellations need a new signature if they are cancelled again.
create function public.reset_tiktok_cancellation_signature() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if TG_TABLE_NAME='tiktok_orders' then
  if old.marketplace_status in('Canceled','Cancelled') and new.marketplace_status not in('Canceled','Cancelled') then
   new.cancellation_signed_at:=null;
   update public.tiktok_order_lines set cancellation_signed_at=null where order_id=new.id and cancelled_at is null;
  end if;
 elsif old.cancelled_at is not null and new.cancelled_at is null then
  new.cancellation_signed_at:=null;
  update public.tiktok_orders set cancellation_signed_at=null where id=new.order_id;
 end if;
 return new;
end$$;
create trigger reset_tiktok_order_cancellation_signature before update of marketplace_status on public.tiktok_orders for each row execute function public.reset_tiktok_cancellation_signature();
create trigger reset_tiktok_line_cancellation_signature before update of cancelled_at on public.tiktok_order_lines for each row execute function public.reset_tiktok_cancellation_signature();
revoke all on function public.sign_tiktok_cancellations(uuid[],uuid[],jsonb,text),public.reset_tiktok_cancellation_signature() from public,anon,authenticated;
grant execute on function public.sign_tiktok_cancellations(uuid[],uuid[],jsonb,text) to authenticated;
notify pgrst,'reload schema';
commit;
