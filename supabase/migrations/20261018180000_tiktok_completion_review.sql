begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Review notes and the completion commit together; retries cannot add notes twice.
create function public.complete_tiktok_orders_review(_order_ids uuid[],_revisions jsonb,_confirmed boolean,_note text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; changed uuid[]; note text:=nullif(btrim(coalesce(_note,'')),''); o public.tiktok_orders;
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then
  raise exception 'Inventory staff access required' using errcode='42501';
 end if;
 if length(coalesce(_note,''))>4000 then raise exception 'Completion notes must be 4,000 characters or fewer';end if;
 perform public.lock_shared_inventory();
 perform pg_advisory_xact_lock(hashtext('tiktok-orders'));
 select array_agg(id order by id) into changed from public.tiktok_orders where id=any(_order_ids) and stage<>'completed';
 result:=public.complete_tiktok_orders(_order_ids,_revisions,_confirmed);
 for o in select * from public.tiktok_orders where id=any(changed) order by id loop
  insert into public.tiktok_order_events(order_id,actor,action,details)
  values(o.id,auth.uid(),'completion_review',jsonb_build_object(
   'notes',note,'actor_email',auth.email(),'confirmed',true,
   'selected_order_ids',to_jsonb(array(select distinct id from unnest(_order_ids) id order by id)),
   'items',(select jsonb_agg(jsonb_build_object('line_id',id,'sku_id',sku_id,'quantity',quantity) order by id) from public.tiktok_order_lines where order_id=o.id),
   'label_document_ids',(select jsonb_agg(id order by id) from public.tiktok_order_documents where order_id=o.id and kind='label')
  ));
 end loop;
 return result;
end$$;
revoke all on function public.complete_tiktok_orders_review(uuid[],jsonb,boolean,text) from public,anon;
grant execute on function public.complete_tiktok_orders_review(uuid[],jsonb,boolean,text) to authenticated;
notify pgrst,'reload schema';
commit;
