begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

alter table public.tiktok_order_lines add column cancelled_at timestamptz;
alter table public.tiktok_order_lines add column cancellation_record jsonb;

create function public.record_tiktok_line_cancellation(_line_id uuid,_revision integer,_cancelled boolean,_reason text,_confirmed boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.tiktok_orders; updated_order public.tiktok_orders; l public.tiktok_order_lines; updated public.tiktok_order_lines; reason text:=btrim(coalesce(_reason,''));
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory staff access required' using errcode='42501';end if;
 if _confirmed is distinct from true or _cancelled is null then raise exception 'Confirm the exact item cancellation in TikTok';end if;
 if length(reason) not between 3 and 2000 then raise exception 'Enter a reason using 3 to 2000 characters';end if;
 if not _cancelled and not coalesce(public.can_revert_order_fulfillment(),false) then raise exception 'Only admins and managers can correct a cancellation mark' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtext('tiktok-orders'));
 select * into l from public.tiktok_order_lines where id=_line_id;
 if not found then raise exception 'TikTok order item not found';end if;
 select * into o from public.tiktok_orders where id=l.order_id for update;
 if _cancelled and l.cancelled_at is not null and l.cancellation_record->>'requested_revision'=_revision::text
  and l.cancellation_record->>'reason'=reason and l.cancellation_record->>'confirmed_by'=auth.uid()::text then return to_jsonb(l);end if;
 if o.revision is distinct from _revision then raise exception 'This order changed. Refresh and review it before saving.' using errcode='40001';end if;
 if o.marketplace_status in('Canceled','Cancelled') then raise exception 'The whole order is cancelled. Review its order cancellation first.';end if;
 if _cancelled then
  if l.cancelled_at is not null then raise exception 'This item is already cancelled';end if;
  update public.tiktok_order_lines set cancelled_at=now(),cancellation_record=jsonb_build_object('source','manual',
   'reason',reason,'confirmed_at',now(),'confirmed_by',auth.uid(),'actor_email',auth.email(),'requested_revision',_revision)
   where id=l.id returning * into updated;
 else
  if l.cancelled_at is null or l.cancellation_record->>'source' is distinct from 'manual' then raise exception 'Only a manual item cancellation can be corrected';end if;
  update public.tiktok_order_lines set cancelled_at=null,cancellation_record=null where id=l.id returning * into updated;
 end if;
 update public.tiktok_orders set revision=revision+1,updated_at=now(),
  stage=case when not _cancelled and l.fulfilled_at is null and stage in('completed','dispatched') then 'preparing' else stage end,
  reopened_at=case when not _cancelled and l.fulfilled_at is null then now() else reopened_at end where id=o.id returning * into updated_order;
 insert into public.tiktok_order_events(order_id,actor,action,details) values(o.id,auth.uid(),
  case when _cancelled then 'line_cancellation_confirmed' else 'line_cancellation_corrected' end,
  jsonb_build_object('line_id',l.id,'sku_id',l.sku_id,'title',l.title,'quantity',l.quantity,'notes',reason,'source','manual',
   'actor_email',auth.email(),'before',to_jsonb(l),'after',to_jsonb(updated),'before_order',to_jsonb(o),'after_order',to_jsonb(updated_order),'inventory_changed',false));
 return to_jsonb(updated);
end$$;

create function public.record_tiktok_buyer_cancellations(_order_ids uuid[],_revisions jsonb,_reason text,_confirmed boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare ids uuid[]; o public.tiktok_orders;
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory staff access required' using errcode='42501';end if;
 if coalesce(cardinality(_order_ids),0) not between 1 and 500 or array_position(_order_ids,null) is not null or jsonb_typeof(_revisions) is distinct from 'object' then raise exception 'Select the orders to cancel';end if;
 perform pg_advisory_xact_lock(hashtext('tiktok-orders'));
 select array_agg(distinct id order by id) into ids from unnest(_order_ids) id;
 if (select count(*) from public.tiktok_orders where id=any(ids))<>cardinality(ids) then raise exception 'Order not found';end if;
 if (select count(distinct lower(buyer_username)) from public.tiktok_orders where id=any(ids))<>1 then raise exception 'Select orders belonging to one buyer';end if;
 for o in select * from public.tiktok_orders where id=any(ids) order by id for update loop
  perform public.record_tiktok_cancellation(o.id,(_revisions->>o.id::text)::integer,true,_reason,_confirmed);
 end loop;
 return jsonb_build_object('cancelled',cardinality(ids));
end$$;

-- Preserve cancelled item marks across imports. They are staff evidence, not CSV fields.
-- Also retain newly discovered cancelled orders so an All-orders report can show every cancellation.
do $$declare def text; signature text;begin
 select pg_get_functiondef('public.import_tiktok_orders(jsonb,text,text,timestamptz)'::regprocedure) into def;
 if position('if r->>''marketplace_status''<>''To ship'' then' in def)=0 then raise exception 'Missing historical import guard';end if;
 def:=replace(def,'if r->>''marketplace_status''<>''To ship'' then','if r->>''marketplace_status'' not in(''To ship'',''Canceled'',''Cancelled'') then');
 -- An unchanged CSV may have been imported by the old version, which skipped new
 -- cancellations. Recover only those absent orders, retaining the original import.
 def:=replace(def,'import_result jsonb;', 'import_result jsonb; recovering boolean:=false;');
 if position('if found then return imp.result||jsonb_build_object(''already_imported'',true);end if;' in def)=0 then raise exception 'Missing duplicate import guard';end if;
 def:=replace(def,'if found then return imp.result||jsonb_build_object(''already_imported'',true);end if;',
  $patch$if found then
   if coalesce((imp.result->>'history_skipped')::integer,0)>0 and exists(select 1 from jsonb_array_elements(_rows) x where x->>'marketplace_status' in('Canceled','Cancelled') and not exists(select 1 from public.tiktok_orders where order_number=x->>'order_number')) then
    _rows:=(select jsonb_agg(x) from jsonb_array_elements(_rows) x where x->>'marketplace_status' in('Canceled','Cancelled') and not exists(select 1 from public.tiktok_orders where order_number=x->>'order_number'));
    _snapshot_at:=imp.snapshot_at;recovering:=true;
   else return imp.result||jsonb_build_object('already_imported',true);end if;
  end if;$patch$);
 def:=replace(def,'insert into public.tiktok_order_imports(file_hash,filename,snapshot_at,imported_by)', 'if not recovering then insert into public.tiktok_order_imports(file_hash,filename,snapshot_at,imported_by)');
 def:=replace(def,'returning * into imp;', 'returning * into imp;end if;');
 def:=replace(def,'update public.tiktok_order_imports set result=import_result',
  $patch$if recovering then import_result:=imp.result||jsonb_build_object('added',coalesce((imp.result->>'added')::integer,0)+added,'history_skipped',greatest(0,(imp.result->>'history_skipped')::integer-added),'cancelled_recovered',added);end if;
  update public.tiktok_order_imports set result=import_result$patch$);
 execute def;
 -- The selected-line checkout must reject cancelled items even if called outside the UI.
 select pg_get_functiondef('public.complete_tiktok_order_lines_review(uuid[],jsonb,boolean,text)'::regprocedure) into def;
 if position('if l.item_search=' in def)=0 then raise exception 'Missing item readiness guard';end if;
 def:=replace(def,'if l.item_search=', 'if l.cancelled_at is not null then raise exception ''A selected item is cancelled. Refresh and review the selection.'';end if; if l.item_search=');
 def:=replace(def,'where order_id=o.id and fulfilled_at is null','where order_id=o.id and fulfilled_at is null and cancelled_at is null');
 execute def;
 foreach signature in array array['public.guard_tiktok_work_stage()','public.tiktok_legacy_line_completion()'] loop
  select pg_get_functiondef(signature::regprocedure) into def;
  if position('where order_id=new.id and fulfilled_at is null' in def)=0 then raise exception 'Missing outstanding item guard';end if;
  def:=replace(def,'where order_id=new.id and fulfilled_at is null','where order_id=new.id and fulfilled_at is null and cancelled_at is null');
  if signature='public.guard_tiktok_work_stage()' then
   def:=replace(def,'begin',E'begin\n if new.stage in(''packed'',''completed'',''dispatched'') and new.stage is distinct from old.stage and exists(select 1 from public.tiktok_order_lines where order_id=new.id and cancelled_at is not null) and not exists(select 1 from public.tiktok_order_lines where order_id=new.id and cancelled_at is null) then raise exception ''All items in this order are cancelled'';end if;');
  end if;
  execute def;
 end loop;
 foreach signature in array array['public.save_tiktok_line_work(uuid,integer,text,text,boolean,uuid)','public.save_tiktok_inventory_attachment(uuid,uuid,uuid,uuid,integer,integer)'] loop
  select pg_get_functiondef(signature::regprocedure) into def;
  if position('if l.fulfilled_at is not null or' in def)=0 then raise exception 'Missing closed line guard';end if;
  execute replace(def,'if l.fulfilled_at is not null or','if l.cancelled_at is not null or l.fulfilled_at is not null or');
 end loop;
 -- Cancelled item work cannot hold the remaining live items or their dispatch.
 select pg_get_functiondef('public.assert_tiktok_work_ready(uuid[])'::regprocedure) into def;
 execute replace(def,'and (coalesce(c.pending,false) or w.watch_missing', 'and (coalesce(c.pending,false) or l.cancelled_at is null) and (coalesce(c.pending,false) or w.watch_missing');
 select pg_get_functiondef('public.guard_tiktok_inventory_dispatch()'::regprocedure) into def;
 execute replace(def,'where l.order_id=new.id and', 'where l.order_id=new.id and l.cancelled_at is null and');
 -- Legacy whole-order checkout cannot include cancelled lines. Use the selected-line workflow.
 select pg_get_functiondef('public.complete_tiktok_orders(uuid[],jsonb,boolean)'::regprocedure) into def;
 if position('begin' in def)=0 then raise exception 'Missing work readiness guard';end if;
 execute replace(def,'begin',E'begin\n if exists(select 1 from public.tiktok_order_lines where order_id=any(_order_ids) and cancelled_at is not null) then raise exception ''This order has cancelled items. Complete only its available items.'';end if;');
end$$;

revoke all on function public.record_tiktok_line_cancellation(uuid,integer,boolean,text,boolean),public.record_tiktok_buyer_cancellations(uuid[],jsonb,text,boolean) from public,anon,authenticated;
grant execute on function public.record_tiktok_line_cancellation(uuid,integer,boolean,text,boolean),public.record_tiktok_buyer_cancellations(uuid[],jsonb,text,boolean) to authenticated;
notify pgrst,'reload schema';
commit;
