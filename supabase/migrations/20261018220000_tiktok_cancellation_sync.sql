begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

-- Marketplace cancellation is distinct from the staff's pending-cancellation hold.
alter table public.tiktok_orders add column cancellation_record jsonb;

create function public.record_tiktok_cancellation(_order_id uuid,_revision integer,_cancelled boolean,_reason text,_confirmed boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.tiktok_orders; updated public.tiktok_orders; reason text:=btrim(coalesce(_reason,'')); hold jsonb;
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory staff access required' using errcode='42501';end if;
 if _confirmed is distinct from true or _cancelled is null then raise exception 'Confirm the status you checked in TikTok' using errcode='22023';end if;
 if length(reason) not between 3 and 2000 then raise exception 'Enter a reason using 3 to 2000 characters' using errcode='22023';end if;
 if not _cancelled and not coalesce(public.can_revert_order_fulfillment(),false) then raise exception 'Only admins and managers can correct a cancellation mark' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtext('tiktok-orders'));
 select * into o from public.tiktok_orders where id=_order_id for update;
 if not found then raise exception 'TikTok order not found';end if;
 if _cancelled and o.marketplace_status in('Canceled','Cancelled') and o.cancellation_record->>'source'='manual'
  and o.cancellation_record->>'requested_revision'=_revision::text and o.cancellation_record->>'reason'=reason
  and o.cancellation_record->>'confirmed_by'=auth.uid()::text then return to_jsonb(o);end if;
 if o.revision is distinct from _revision then raise exception 'This order changed. Refresh and review it before saving.' using errcode='40001';end if;
 select to_jsonb(c) into hold from public.tiktok_order_cancellations c where order_id=o.id;
 if _cancelled then
  if o.marketplace_status in('Canceled','Cancelled') then raise exception 'This order is already marked cancelled';end if;
  update public.tiktok_orders set marketplace_status='Canceled',marketplace_substatus='Canceled',
   cancellation_record=jsonb_build_object('source','manual','reason',reason,'confirmed_at',now(),'confirmed_by',auth.uid(),
    'actor_email',auth.email(),'requested_revision',_revision,'previous_status',o.marketplace_status,'previous_substatus',o.marketplace_substatus,'previous_cancellation_hold',hold),
   revision=revision+1,updated_at=now() where id=o.id returning * into updated;
  update public.tiktok_order_cancellations set pending=false,revision=revision+1,updated_by=auth.uid(),updated_at=now() where order_id=o.id and pending;
 else
  if o.marketplace_status not in('Canceled','Cancelled') or o.cancellation_record->>'source' is distinct from 'manual' then
   raise exception 'Only a manual cancellation mark can be corrected. A TikTok export confirmed this status, or it is not cancelled.';end if;
  update public.tiktok_orders set marketplace_status=o.cancellation_record->>'previous_status',marketplace_substatus=o.cancellation_record->>'previous_substatus',
   cancellation_record=null,revision=revision+1,updated_at=now() where id=o.id returning * into updated;
  if o.cancellation_record#>>'{previous_cancellation_hold,pending}'='true' then
   update public.tiktok_order_cancellations set pending=true,reason=o.cancellation_record#>>'{previous_cancellation_hold,reason}',
    revision=revision+1,updated_by=auth.uid(),updated_at=now() where order_id=o.id;
  end if;
 end if;
 -- Recording a marketplace status never deducts/restores stock or clears fulfillment evidence.
 insert into public.tiktok_order_events(order_id,actor,action,details) values(o.id,auth.uid(),
  case when _cancelled then 'cancellation_confirmed' else 'cancellation_corrected' end,
  jsonb_build_object('from',o.marketplace_status,'to',updated.marketplace_status,'notes',reason,'actor_email',auth.email(),
   'source','manual','before',to_jsonb(o),'after',to_jsonb(updated),'previous_cancellation_hold',hold,'inventory_changed',false));
 return to_jsonb(updated);
end $$;

-- Importer already serializes writes, ignores older snapshots and skips unknown historical orders.
-- Keep its stable line IDs, evidence and partial-fulfillment handling; audit only the status changes here.
create function public.audit_tiktok_import_status() returns trigger
language plpgsql security definer set search_path='' as $$
declare before_hold jsonb;
begin
 if new.last_import_id is not distinct from old.last_import_id then return new;end if;
 if old.marketplace_status in('Canceled','Cancelled') and new.marketplace_status not in('Canceled','Cancelled') then
  insert into public.tiktok_order_events(order_id,actor,action,details) values(old.id,auth.uid(),'cancellation_refresh_conflict',
   jsonb_build_object('import_id',new.last_import_id,'snapshot_at',new.source_snapshot_at,'from',old.marketplace_status,
    'reported_status',new.marketplace_status,'to',old.marketplace_status,'source','export','actor_email',auth.email(),
    'notes','Export disagrees with the recorded cancellation. Cancellation kept; a manager must review a manual correction.'));
  new.marketplace_status:=old.marketplace_status;new.marketplace_substatus:=old.marketplace_substatus;
  new.cancellation_record:=old.cancellation_record;
 elsif new.marketplace_status in('Canceled','Cancelled') and
  (old.marketplace_status not in('Canceled','Cancelled') or old.cancellation_record->>'source' is distinct from 'export') then
  new.cancellation_record:=jsonb_build_object('source','export','reason',coalesce(nullif(btrim(new.cancel_return),''),'TikTok CSV confirms cancellation'),
   'confirmed_at',now(),'confirmed_by',auth.uid(),'actor_email',auth.email(),'import_id',new.last_import_id,
   'previous_status',old.marketplace_status,'previous_substatus',old.marketplace_substatus);
  select to_jsonb(c) into before_hold from public.tiktok_order_cancellations c where order_id=old.id;
  update public.tiktok_order_cancellations set pending=false,revision=revision+1,updated_by=auth.uid(),updated_at=now() where order_id=old.id and pending;
  insert into public.tiktok_order_events(order_id,actor,action,details) values(old.id,auth.uid(),'cancellation_imported',
   jsonb_build_object('import_id',new.last_import_id,'snapshot_at',new.source_snapshot_at,'from',old.marketplace_status,'to',new.marketplace_status,
    'notes',new.cancellation_record->>'reason','source','export','actor_email',auth.email(),'before',to_jsonb(old),'after',to_jsonb(new),
    'previous_cancellation_hold',before_hold,'inventory_changed',false));
 elsif new.marketplace_status is distinct from old.marketplace_status or new.marketplace_substatus is distinct from old.marketplace_substatus then
  insert into public.tiktok_order_events(order_id,actor,action,details) values(old.id,auth.uid(),'marketplace_status_updated',
   jsonb_build_object('import_id',new.last_import_id,'snapshot_at',new.source_snapshot_at,'from',old.marketplace_status,'to',new.marketplace_status,
    'previous_substatus',old.marketplace_substatus,'substatus',new.marketplace_substatus,'source','export','actor_email',auth.email()));
 end if;
 return new;
end $$;
create trigger audit_tiktok_import_status before update of last_import_id on public.tiktok_orders for each row execute function public.audit_tiktok_import_status();
revoke all on function public.record_tiktok_cancellation(uuid,integer,boolean,text,boolean),public.audit_tiktok_import_status() from public,anon,authenticated;
grant execute on function public.record_tiktok_cancellation(uuid,integer,boolean,text,boolean) to authenticated;
commit;
