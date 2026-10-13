begin;
set local lock_timeout='3s';
set local statement_timeout='60s';
-- Immutable evidence of a locally signed completion of an entire pending order.
-- This never changes fulfillment, packing, payment or customer-promise rules.
create table public.pending_order_completion_events (
 id uuid primary key default gen_random_uuid(),
 order_id uuid not null,
 actor_user_id uuid not null,
 occurred_at timestamptz not null,
 transaction_id bigint not null,
 order_number text,
 buyer_username text,
 items jsonb not null,
 record_basis text not null check(record_basis in ('signed_completion','verified_historical_snapshot')),
 unique(order_id,transaction_id)
);
alter table public.pending_order_completion_events enable row level security;
revoke all on public.pending_order_completion_events from public,anon,authenticated;
create index work_order_completion_actor_time on public.pending_order_completion_events(actor_user_id,occurred_at);

create function public.record_pending_order_completion() returns trigger
language plpgsql security definer set search_path='' as $$
declare target record;
begin
 if auth.uid() is null then return null; end if;
 for target in
  select distinct n.order_id from work_new_lines n join work_old_lines o on o.id=n.id
  where o.line_status in ('pending','partially_fulfilled')
   and n.line_status in ('fulfilled','cancelled','skipped')
   and n.fulfilled_by=auth.uid() and n.fulfilled_at is not null
   and n.fulfilled_at is distinct from o.fulfilled_at
  order by n.order_id
 loop
  -- Serialize the final check when different lines of one order finish together.
  perform pg_advisory_xact_lock(hashtextextended('pending-order-completion:'||target.order_id::text,0));
  if exists(select 1 from public.ebay_order_lines l where l.order_id=target.order_id and
     (l.line_status is null or l.line_status not in ('fulfilled','cancelled','skipped')
      or (l.line_status='fulfilled' and coalesce(l.fulfilled_quantity,0)<l.quantity))) then continue; end if;
  if not exists(select 1 from public.ebay_order_lines l where l.order_id=target.order_id
     and l.line_status='fulfilled' and l.fulfilled_quantity>0) then continue; end if;
  insert into public.pending_order_completion_events(order_id,actor_user_id,occurred_at,transaction_id,order_number,buyer_username,items,record_basis)
  select o.id,auth.uid(),now(),txid_current(),o.order_number,o.buyer_username,
   (select jsonb_agg(jsonb_build_object('order_line_id',l.id,'item_title',l.item_title,'item_number',l.item_number,
    'quantity',l.quantity,'fulfilled_quantity',l.fulfilled_quantity,'status',l.line_status) order by l.id)
    from public.ebay_order_lines l where l.order_id=o.id),'signed_completion'
  from public.ebay_orders o where o.id=target.order_id
  on conflict(order_id,transaction_id) do nothing;
 end loop;
 return null;
end $$;
revoke all on function public.record_pending_order_completion() from public,anon,authenticated;
create trigger record_pending_order_completion after update on public.ebay_order_lines
 referencing old table as work_old_lines new table as work_new_lines
 for each statement execute function public.record_pending_order_completion();

-- Recover only current complete orders whose final fulfillment is supported by
-- a same-time signed closeout or the recorded stock checkout. Imported status
-- alone, cancelled-only orders, partial orders and package closeouts do not qualify.
insert into public.pending_order_completion_events(order_id,actor_user_id,occurred_at,transaction_id,order_number,buyer_username,items,record_basis)
select o.id,last_line.fulfilled_by,last_line.fulfilled_at,0,o.order_number,o.buyer_username,
 (select jsonb_agg(jsonb_build_object('order_line_id',l.id,'item_title',l.item_title,'item_number',l.item_number,
  'quantity',l.quantity,'fulfilled_quantity',l.fulfilled_quantity,'status',l.line_status) order by l.id)
  from public.ebay_order_lines l where l.order_id=o.id),'verified_historical_snapshot'
from public.ebay_orders o
cross join lateral (select l.* from public.ebay_order_lines l where l.order_id=o.id and l.fulfilled_at is not null
 order by l.fulfilled_at desc,l.id desc limit 1) last_line
where last_line.fulfilled_by is not null
 and exists(select 1 from public.ebay_order_lines l where l.order_id=o.id and l.line_status='fulfilled' and l.fulfilled_quantity>0)
 and not exists(select 1 from public.ebay_order_lines l where l.order_id=o.id and
  (l.line_status is null or l.line_status not in ('fulfilled','cancelled','skipped')
   or (l.line_status='fulfilled' and coalesce(l.fulfilled_quantity,0)<l.quantity)))
 -- A later imported completion cannot be credited to an earlier local signer.
 and not exists(select 1 from public.ebay_order_lines l where l.order_id=o.id and l.line_status='fulfilled'
  and (l.fulfilled_by is null or l.fulfilled_at is null))
 and (
  exists(select 1 from public.ebay_order_admin_events e where e.signed_by=last_line.fulfilled_by
   and e.action='fulfilled_no_inventory' and last_line.id=any(e.order_line_ids) and e.created_at=last_line.fulfilled_at)
  or exists(select 1 from public.stock_transactions t where t.id=last_line.stock_transaction_id
   and t.user_id=last_line.fulfilled_by and t.action_type='checkout'
   and coalesce(t.confirmed_at,t.timestamp)=last_line.fulfilled_at)
 );

create or replace view public.admin_work_event_stream as
-- team_task_events
select 'team_task_events:' || e.id::text as event_key, 'team_task_events'::text as source, e.signed_by as actor_user_id,
 e.created_at as occurred_at, 'tasks'::text as category, e.action as action,
 coalesce(t.title,'tasks')::text as title, e.notes as notes, e.id::text as entity_id,
 case when e.new_status='completed_by_employee' and coalesce(e.old_status,'') not in ('completed_by_employee','resolved','closed','cancelled','shipped_completed') then 'tasks_completed' when e.new_status in ('resolved','closed','shipped_completed') and coalesce(e.old_status,'') not in ('resolved','closed','shipped_completed') then 'tasks_closed' end as metric, (0::numeric)::numeric as quantity, to_jsonb(e) || jsonb_build_object('task_source','team','task_title',t.title,'task_type',t.task_type) as details
from public.team_task_events e left join public.team_tasks t on t.id=e.task_id
union all
-- ebay_order_task_events
select 'ebay_order_task_events:' || e.id::text as event_key, 'ebay_order_task_events'::text as source, e.signed_by as actor_user_id,
 e.created_at as occurred_at, 'tasks'::text as category, e.action as action,
 coalesce(t.title,'tasks')::text as title, e.notes as notes, e.id::text as entity_id,
 case when e.new_status='completed_by_employee' and coalesce(e.old_status,'') not in ('completed_by_employee','resolved','closed','cancelled','shipped_completed') then 'tasks_completed' when e.new_status in ('resolved','closed','shipped_completed') and coalesce(e.old_status,'') not in ('resolved','closed','shipped_completed') then 'tasks_closed' end as metric, (0::numeric)::numeric as quantity, to_jsonb(e) || jsonb_build_object('task_source','order','task_title',t.title,'task_type',t.task_type) as details
from public.ebay_order_task_events e left join public.ebay_order_tasks t on t.id=e.task_id
union all
-- ebay_return_task_events
select 'ebay_return_task_events:' || e.id::text as event_key, 'ebay_return_task_events'::text as source, e.signed_by as actor_user_id,
 e.created_at as occurred_at, 'tasks'::text as category, e.action as action,
 coalesce(t.title,'tasks')::text as title, e.notes as notes, e.id::text as entity_id,
 case when e.new_status='completed_by_employee' and coalesce(e.old_status,'') not in ('completed_by_employee','resolved','closed','cancelled','shipped_completed') then 'tasks_completed' when e.new_status in ('resolved','closed','shipped_completed') and coalesce(e.old_status,'') not in ('resolved','closed','shipped_completed') then 'tasks_closed' end as metric, (0::numeric)::numeric as quantity, to_jsonb(e) || jsonb_build_object('task_source','return','task_title',t.title,'task_type',t.task_type) as details
from public.ebay_return_task_events e left join public.ebay_return_tasks t on t.id=e.task_id
union all
-- inventory_change_log
select 'inventory_change_log:' || e.id::text as event_key, 'inventory_change_log'::text as source, e.worker_id as actor_user_id,
 e.changed_at as occurred_at, 'inventory'::text as category, e.action as action,
 coalesce(coalesce(e.item_title,e.location_name,e.summary),'inventory')::text as title, e.reason as notes, e.id::text as entity_id,
 case when e.table_name='item_types' and e.action='insert' then 'items_created' end as metric, (0::numeric)::numeric as quantity, to_jsonb(e) as details
from public.inventory_change_log e
union all
-- stock_transactions
select 'stock_transactions:' || e.id::text as event_key, 'stock_transactions'::text as source, e.user_id as actor_user_id,
 coalesce(e.confirmed_at,e.timestamp) as occurred_at, 'stock'::text as category, e.action_type as action,
 coalesce(i.title,'stock')::text as title, e.notes as notes, e.id::text as entity_id,
 case when e.action_type='checkin' and e.quantity>0 then 'units_checked_in' end as metric, (e.quantity)::numeric as quantity, to_jsonb(e) || jsonb_build_object('item_title',i.title,'barcode',i.barcode,'location',l.location_name) as details
from public.stock_transactions e left join public.item_types i on i.id=e.item_id left join public.locations l on l.id=e.location_id
union all
-- tray_movements
select 'tray_movements:' || e.id::text as event_key, 'tray_movements'::text as source, e.performed_by as actor_user_id,
 e.created_at as occurred_at, 'transfers'::text as category, e.action as action,
 coalesce(l.location_name,'transfers')::text as title, e.notes as notes, e.id::text as entity_id,
 null::text as metric, (0::numeric)::numeric as quantity, to_jsonb(e) as details
from public.tray_movements e left join public.locations l on l.id=e.tray_location_id
union all
-- store_transfer_events
select 'store_transfer_events:' || e.id::text as event_key, 'store_transfer_events'::text as source, e.actor_user_id as actor_user_id,
 e.created_at as occurred_at, 'transfers'::text as category, e.action as action,
 coalesce('Transfer '||t.transfer_number,'transfers')::text as title, e.notes as notes, e.id::text as entity_id,
 null::text as metric, (0::numeric)::numeric as quantity, to_jsonb(e) as details
from public.store_transfer_events e left join public.store_transfers t on t.id=e.transfer_id
union all
-- change_reversion_log
select 'change_reversion_log:' || e.id::text as event_key, 'change_reversion_log'::text as source, e.performed_by as actor_user_id,
 e.performed_at as occurred_at, 'inventory'::text as category, 'revert_'||e.direction as action,
 coalesce(e.item_title,'inventory')::text as title, e.reason as notes, e.id::text as entity_id,
 null::text as metric, (0::numeric)::numeric as quantity, to_jsonb(e) as details
from public.change_reversion_log e
union all
-- daily_stock_checkin_adjustments
select 'daily_stock_checkin_adjustments:' || e.id::text as event_key, 'daily_stock_checkin_adjustments'::text as source, e.performed_by as actor_user_id,
 e.created_at as occurred_at, 'stock'::text as category, 'checkin_corrected' as action,
 coalesce(i.title,'stock')::text as title, e.reason as notes, e.id::text as entity_id,
 null::text as metric, (e.quantity_delta)::numeric as quantity, to_jsonb(e) as details
from public.daily_stock_checkin_adjustments e left join public.item_types i on i.id=e.item_id
union all
-- photo_deletion_log
select 'photo_deletion_log:' || e.id::text as event_key, 'photo_deletion_log'::text as source, e.deleted_by as actor_user_id,
 e.deleted_at as occurred_at, 'photos'::text as category, 'photo_removed' as action,
 coalesce(e.item_title,'photos')::text as title, e.reason as notes, e.id::text as entity_id,
 null::text as metric, (0::numeric)::numeric as quantity, jsonb_build_object('item_id',e.item_id,'item_barcode',e.item_barcode,'photo_path',e.photo_path,'reason',e.reason) as details
from public.photo_deletion_log e
union all
-- photo_restores
select 'photo_restores:' || e.id::text as event_key, 'photo_restores'::text as source, e.restored_by as actor_user_id,
 e.restored_at as occurred_at, 'photos'::text as category, 'photo_restored' as action,
 coalesce(e.item_title,'photos')::text as title, null::text as notes, e.id::text as entity_id,
 null::text as metric, (0::numeric)::numeric as quantity, jsonb_build_object('item_id',e.item_id,'photo_path',e.photo_path) as details
from public.photo_deletion_log e
where e.restored_at is not null
union all
-- ebay_order_admin_events
select 'ebay_order_admin_events:' || e.id::text as event_key, 'ebay_order_admin_events'::text as source, e.signed_by as actor_user_id,
 e.created_at as occurred_at, 'orders'::text as category, e.action as action,
 coalesce(coalesce(e.payload->>'item_title',e.payload->>'order_number','Order action'),'orders')::text as title, e.notes as notes, e.id::text as entity_id,
 null::text as metric, (0::numeric)::numeric as quantity, to_jsonb(e) as details
from public.ebay_order_admin_events e
union all
-- ebay_order_revert_events
select 'ebay_order_revert_events:' || e.id::text as event_key, 'ebay_order_revert_events'::text as source, e.signed_by as actor_user_id,
 e.created_at as occurred_at, 'orders'::text as category, 'order_reverted' as action,
 coalesce('Order fulfillment reversed','orders')::text as title, e.notes as notes, e.id::text as entity_id,
 null::text as metric, (0::numeric)::numeric as quantity, to_jsonb(e) as details
from public.ebay_order_revert_events e
union all
-- ebay_order_label_events
select 'ebay_order_label_events:' || e.id::text as event_key, 'ebay_order_label_events'::text as source, e.signed_by as actor_user_id,
 e.created_at as occurred_at, 'orders'::text as category, e.action as action,
 coalesce('Shipping label · '||coalesce(array_to_string(e.order_numbers,', '),'order'),'orders')::text as title, null::text as notes, e.id::text as entity_id,
 null::text as metric, (0::numeric)::numeric as quantity, to_jsonb(e) as details
from public.ebay_order_label_events e
union all
-- pending_inventory_attachment_events
select 'pending_inventory_attachment_events:' || e.id::text as event_key, 'pending_inventory_attachment_events'::text as source, e.created_by as actor_user_id,
 e.created_at as occurred_at, 'orders'::text as category, e.action as action,
 coalesce('Inventory attachment · '||coalesce(l.item_title,'order item'),'orders')::text as title, null::text as notes, e.id::text as entity_id,
 null::text as metric, (0::numeric)::numeric as quantity, to_jsonb(e) as details
from public.pending_inventory_attachment_events e left join public.ebay_order_lines l on l.id=e.order_line_id
union all
-- pending_order_item_search_events
select 'pending_order_item_search_events:' || e.id::text as event_key, 'pending_order_item_search_events'::text as source, e.signed_by as actor_user_id,
 e.created_at as occurred_at, 'orders'::text as category, case when e.is_missing then 'item_marked_missing' else 'item_found' end as action,
 coalesce(l.item_title,'orders')::text as title, null::text as notes, e.id::text as entity_id,
 null::text as metric, (0::numeric)::numeric as quantity, to_jsonb(e) as details
from public.pending_order_item_search_events e left join public.ebay_order_lines l on l.id=e.order_line_id
union all
-- pending_order_work_events
select 'pending_order_work_events:' || e.id::text as event_key, 'pending_order_work_events'::text as source, e.signed_by as actor_user_id,
 e.created_at as occurred_at, 'orders'::text as category, e.action as action,
 coalesce('Order follow-up · '||coalesce(b.buyer_key,'customer'),'orders')::text as title, b.reason as notes, e.id::text as entity_id,
 null::text as metric, (0::numeric)::numeric as quantity, to_jsonb(e) as details
from public.pending_order_work_events e left join public.pending_order_work_blockers b on b.id=e.blocker_id
union all
-- order_line_watch_events
select 'order_line_watch_events:' || e.id::text as event_key, 'order_line_watch_events'::text as source, e.signed_by as actor_user_id,
 e.created_at as occurred_at, 'orders'::text as category, case when e.is_watch then 'watch_flag_added' else 'watch_flag_removed' end as action,
 coalesce(l.item_title,'orders')::text as title, null::text as notes, e.id::text as entity_id,
 null::text as metric, (0::numeric)::numeric as quantity, to_jsonb(e) as details
from public.order_line_watch_events e left join public.ebay_order_lines l on l.id=e.order_line_id
union all
-- ebay_return_events
select 'ebay_return_events:' || e.id::text as event_key, 'ebay_return_events'::text as source, e.signed_by as actor_user_id,
 e.created_at as occurred_at, 'returns'::text as category, e.action as action,
 coalesce('Return · '||coalesce(o.order_number,e.return_case_id::text),'returns')::text as title, e.notes as notes, e.id::text as entity_id,
 null::text as metric, (0::numeric)::numeric as quantity, to_jsonb(e) as details
from public.ebay_return_events e left join public.ebay_orders o on o.id=e.order_id
union all
-- packaging_events
select 'packaging_events:' || e.id::text as event_key, 'packaging_events'::text as source, e.created_by as actor_user_id,
 e.created_at as occurred_at, 'packaging'::text as category, e.action as action,
 coalesce(coalesce(p.tracking_code,'Package'),'packaging')::text as title, e.notes as notes, e.id::text as entity_id,
 case when e.action='pack' then 'packages_packed' when e.action='dispatch' then 'packages_dispatched' when e.action in ('admin_closeout','prior_dispatch_closeout') then 'admin_closeouts' end as metric, (0::numeric)::numeric as quantity, to_jsonb(e)||jsonb_build_object('order_ids',p.order_ids,'tracking_code',p.tracking_code) as details
from public.packaging_events e left join public.packaging_shipments p on p.id=e.shipment_id
union all
-- ebay_message_read_events
select 'ebay_message_read_events:' || e.id::text as event_key, 'ebay_message_read_events'::text as source, e.actor_user_id as actor_user_id,
 e.created_at as occurred_at, 'messages'::text as category, case when e.is_read then case when e.send_attempt_id is null then 'marked_read' else 'read_by_reply' end else 'marked_unread' end as action,
 coalesce('Conversation with '||coalesce(c.other_party_username,'customer'),'messages')::text as title, null::text as notes, e.id::text as entity_id,
 null::text as metric, (0::numeric)::numeric as quantity, to_jsonb(e)||jsonb_build_object('buyer_username',c.other_party_username) as details
from public.ebay_message_read_events e left join public.ebay_conversations c on c.id=e.conversation_id
union all
-- ebay_message_activity_events
select 'ebay_message_activity_events:' || e.id::text as event_key, 'ebay_message_activity_events'::text as source, e.actor_user_id as actor_user_id,
 e.created_at as occurred_at, 'messages'::text as category, e.event_type as action,
 coalesce(e.title,'messages')::text as title, e.detail as notes, e.id::text as entity_id,
 case when e.event_type='send_attempt_succeeded' then 'replies_sent' end as metric, (0::numeric)::numeric as quantity, to_jsonb(e)||jsonb_build_object('buyer_username',c.other_party_username) as details
from public.ebay_message_activity_events e left join public.ebay_conversations c on c.id=e.conversation_id
where e.event_type not in ('conversation_synced','message_sync_completed','message_sync_failed','provider_notification_received','read_state_synced','message_backfill_progress')
union all
-- inventory_pricing_events
select 'inventory_pricing_events:' || e.id::text as event_key, 'inventory_pricing_events'::text as source, e.actor as actor_user_id,
 e.created_at as occurred_at, 'pricing'::text as category, e.action as action,
 coalesce(i.title,'pricing')::text as title, null::text as notes, e.id::text as entity_id,
 null::text as metric, (0::numeric)::numeric as quantity, to_jsonb(e)||jsonb_build_object('item_title',i.title,'barcode',i.barcode) as details
from public.inventory_pricing_events e left join public.item_types i on i.id=e.item_id
union all
-- live_sale_events
select 'live_sale_events:' || e.id::text as event_key, 'live_sale_events'::text as source, e.actor as actor_user_id,
 e.created_at as occurred_at, 'live_sales'::text as category, e.event_type as action,
 coalesce('Live sale','live_sales')::text as title, e.notes as notes, e.id::text as entity_id,
 null::text as metric, (0::numeric)::numeric as quantity, to_jsonb(e) as details
from public.live_sale_events e
union all
-- ebay_live_audit
select 'ebay_live_audit:' || e.id::text as event_key, 'ebay_live_audit'::text as source, e.actor as actor_user_id,
 e.created_at as occurred_at, 'live_sales'::text as category, e.action as action,
 coalesce('eBay Live','live_sales')::text as title, null::text as notes, e.id::text as entity_id,
 null::text as metric, (0::numeric)::numeric as quantity, to_jsonb(e) as details
from public.ebay_live_audit e
union all
-- sales_audit
select 'sales_audit:' || e.id::text as event_key, 'sales_audit'::text as source, e.user_id as actor_user_id,
 e.created_at as occurred_at, 'sales'::text as category, 'sale_recorded' as action,
 coalesce('Sale · '||coalesce(e.platform,'store'),'sales')::text as title, e.notes as notes, e.id::text as entity_id,
 null::text as metric, (0::numeric)::numeric as quantity, to_jsonb(e) as details
from public.sales_audit e
union all
-- catalogue_request_events
select 'catalogue_request_events:' || e.id::text as event_key, 'catalogue_request_events'::text as source, e.actor_id as actor_user_id,
 e.created_at as occurred_at, 'catalogues'::text as category, 'request_'||e.status as action,
 coalesce('Catalogue request','catalogues')::text as title, e.message as notes, e.id::text as entity_id,
 null::text as metric, (0::numeric)::numeric as quantity, to_jsonb(e) as details
from public.catalogue_request_events e
union all
-- inventory_catalogues
select 'inventory_catalogues:' || e.id::text as event_key, 'inventory_catalogues'::text as source, e.created_by as actor_user_id,
 e.created_at as occurred_at, 'catalogues'::text as category, 'catalogue_created' as action,
 coalesce(e.title,'catalogues')::text as title, null::text as notes, e.id::text as entity_id,
 null::text as metric, (0::numeric)::numeric as quantity, jsonb_build_object('title',e.title,'item_count',jsonb_array_length(e.items)) as details
from public.inventory_catalogues e
union all
-- work_outing_events
select 'work_outing_events:' || e.id::text as event_key, 'work_outing_events'::text as source, e.actor_user_id as actor_user_id,
 e.created_at as occurred_at, 'offsite'::text as category, e.action as action,
 coalesce(o.purpose,'offsite')::text as title, e.note as notes, e.id::text as entity_id,
 null::text as metric, (0::numeric)::numeric as quantity, to_jsonb(e)||jsonb_build_object('destination',o.destination,'purpose',o.purpose) as details
from public.work_outing_events e left join public.work_outings o on o.id=e.outing_id
union all
-- schedule_audit_log
select 'schedule_audit_log:' || e.id::text as event_key, 'schedule_audit_log'::text as source, e.actor_user_id as actor_user_id,
 e.occurred_at as occurred_at, 'administration'::text as category, e.action as action,
 coalesce('Schedule · '||coalesce(e.employee_name,e.employee_email),'administration')::text as title, e.schedule_note as notes, e.id::text as entity_id,
 null::text as metric, (0::numeric)::numeric as quantity, to_jsonb(e)-'request_metadata' as details
from public.schedule_audit_log e
union all
-- time_entry_admin_audits
select 'time_entry_admin_audits:' || e.id::text as event_key, 'time_entry_admin_audits'::text as source, e.editor_user_id as actor_user_id,
 e.edited_at as occurred_at, 'administration'::text as category, e.action as action,
 coalesce('Shift correction · '||coalesce(w.display_name,w.email),'administration')::text as title, e.reason as notes, e.id::text as entity_id,
 null::text as metric, (0::numeric)::numeric as quantity, to_jsonb(e) as details
from public.time_entry_admin_audits e left join public.employees w on w.id=e.employee_id
union all
-- shift_adjustments
select 'shift_adjustments:' || e.id::text as event_key, 'shift_adjustments'::text as source, e.editor_user_id as actor_user_id,
 e.edited_at as occurred_at, 'administration'::text as category, 'shift_time_adjusted' as action,
 coalesce('Shift time adjusted','administration')::text as title, e.reason as notes, e.id::text as entity_id,
 null::text as metric, (0::numeric)::numeric as quantity, to_jsonb(e) as details
from public.shift_adjustments e
union all
-- pending_checkout_receipts
select 'pending_checkout_receipts:' || e.request_id::text as event_key, 'pending_checkout_receipts'::text as source, e.user_id as actor_user_id,
 e.created_at as occurred_at, 'orders'::text as category, 'batch_recorded' as action,
 coalesce('Order checkout','orders')::text as title, null::text as notes, e.request_id::text as entity_id,
 null::text as metric, (0::numeric)::numeric as quantity, to_jsonb(e) as details
from public.pending_checkout_receipts e
union all
-- inventory_receiving_receipts
select 'inventory_receiving_receipts:' || e.request_id::text as event_key, 'inventory_receiving_receipts'::text as source, e.user_id as actor_user_id,
 e.created_at as occurred_at, 'inventory'::text as category, 'batch_recorded' as action,
 coalesce('Inventory received','inventory')::text as title, null::text as notes, e.request_id::text as entity_id,
 null::text as metric, (0::numeric)::numeric as quantity, to_jsonb(e) as details
from public.inventory_receiving_receipts e
union all
-- bulk_receiving_receipts
select 'bulk_receiving_receipts:' || e.bag_barcode as event_key, 'bulk_receiving_receipts'::text as source, e.user_id as actor_user_id,
 e.created_at as occurred_at, 'inventory'::text as category, 'batch_recorded' as action,
 coalesce('Bulk inventory received','inventory')::text as title, null::text as notes, e.bag_barcode as entity_id,
 null::text as metric, (0::numeric)::numeric as quantity, to_jsonb(e) as details
from public.bulk_receiving_receipts e
union all
-- customer_return_receipts
select 'customer_return_receipts:' || e.id::text as event_key, 'customer_return_receipts'::text as source, e.actor as actor_user_id,
 e.created_at as occurred_at, 'returns'::text as category, 'return_received' as action,
 coalesce('Customer return received','returns')::text as title, null::text as notes, e.id::text as entity_id,
 null::text as metric, (0::numeric)::numeric as quantity, to_jsonb(e) as details
from public.customer_return_receipts e
union all
-- ebay_order_line_certificates
select 'ebay_order_line_certificates:' || e.id::text as event_key, 'ebay_order_line_certificates'::text as source, e.created_by as actor_user_id,
 e.created_at as occurred_at, 'orders'::text as category, 'certificate_saved' as action,
 coalesce('Certificate · '||coalesce(e.report_number,e.watch_serial),'orders')::text as title, null::text as notes, e.id::text as entity_id,
 null::text as metric, (0::numeric)::numeric as quantity, to_jsonb(e)-array['voided_at','voided_by','void_reason']::text[] as details
from public.ebay_order_line_certificates e
union all
-- certificate_voids
select 'certificate_voids:' || e.id::text as event_key, 'certificate_voids'::text as source, e.voided_by as actor_user_id,
 e.voided_at as occurred_at, 'orders'::text as category, 'certificate_voided' as action,
 coalesce('Certificate · '||coalesce(e.report_number,e.watch_serial),'orders')::text as title, e.void_reason as notes, e.id::text as entity_id,
 null::text as metric, (0::numeric)::numeric as quantity, to_jsonb(e) as details
from public.ebay_order_line_certificates e
where e.voided_at is not null
union all
-- clock_in
select 'clock_in:' || e.id::text as event_key, 'clock_in'::text as source, w.user_id as actor_user_id,
 e.clock_in as occurred_at, 'attendance'::text as category, 'clock_in' as action,
 coalesce('Recorded clock-in','attendance')::text as title, e.note as notes, e.id::text as entity_id,
 null::text as metric, (0::numeric)::numeric as quantity, jsonb_build_object('time_entry_id',e.id,'store',s.name,'schedule_note',e.schedule_note,'record_basis','Current time record; admin corrections appear separately.') as details
from public.time_entries e join public.employees w on w.id=e.employee_id left join public.store_locations s on s.id=e.store_id
where e.clock_in is not null
union all
-- clock_out
select 'clock_out:' || e.id::text as event_key, 'clock_out'::text as source, w.user_id as actor_user_id,
 e.clock_out as occurred_at, 'attendance'::text as category, 'clock_out' as action,
 coalesce('Recorded clock-out','attendance')::text as title, e.note as notes, e.id::text as entity_id,
 null::text as metric, (0::numeric)::numeric as quantity, jsonb_build_object('time_entry_id',e.id,'store',s.name,'schedule_note',e.schedule_note,'record_basis','Current time record; admin corrections appear separately.') as details
from public.time_entries e join public.employees w on w.id=e.employee_id left join public.store_locations s on s.id=e.store_id
where e.clock_out is not null
union all
-- break_started
select 'break_started:' || e.id::text as event_key, 'break_started'::text as source, w.user_id as actor_user_id,
 e.started_at as occurred_at, 'attendance'::text as category, 'break_started' as action,
 coalesce('Recorded break started','attendance')::text as title, null::text as notes, e.id::text as entity_id,
 null::text as metric, (0::numeric)::numeric as quantity, jsonb_build_object('time_entry_id',e.time_entry_id,'break_id',e.id,'record_basis','Current break record') as details
from public.time_breaks e join public.time_entries t on t.id=e.time_entry_id join public.employees w on w.id=t.employee_id
where e.started_at is not null
union all
-- break_ended
select 'break_ended:' || e.id::text as event_key, 'break_ended'::text as source, w.user_id as actor_user_id,
 e.ended_at as occurred_at, 'attendance'::text as category, 'break_ended' as action,
 coalesce('Recorded break ended','attendance')::text as title, null::text as notes, e.id::text as entity_id,
 null::text as metric, (0::numeric)::numeric as quantity, jsonb_build_object('time_entry_id',e.time_entry_id,'break_id',e.id,'record_basis','Current break record') as details
from public.time_breaks e join public.time_entries t on t.id=e.time_entry_id join public.employees w on w.id=t.employee_id
where e.ended_at is not null
union all
select 'pending_order_completion_events:'||e.id::text,'pending_order_completion_events',e.actor_user_id,e.occurred_at,
 'closed_orders','pending_order_closed',coalesce(e.order_number,'Order')||coalesce(' · '||e.buyer_username,''),
 null::text,e.order_id::text,'pending_orders_closed',0::numeric,
 jsonb_build_object('order_id',e.order_id,'order_number',e.order_number,'buyer_username',e.buyer_username,
  'items',e.items,'record_basis',e.record_basis)
from public.pending_order_completion_events e;
revoke all on public.admin_work_event_stream from public,anon,authenticated;
create or replace function public.admin_employee_work_report(
 _day date default (now() at time zone 'America/New_York')::date,
 _employee_id uuid default null, _shift_id uuid default null,
 _category text default null, _search text default null,
 _offset integer default 0, _limit integer default 50, _as_of timestamptz default null
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
 start_at timestamptz; end_at timestamptz; snapshot_at timestamptz:=least(coalesce(_as_of,now()),now());
 worker_user uuid; chosen public.time_entries; result jsonb;
begin
 if auth.uid() is null or not exists(select 1 from public.employees where user_id=auth.uid() and active is true and lower(role)='admin') then
  raise exception 'Active admin access required' using errcode='42501';
 end if;
 if _day is null or _offset is null or _offset<0 or _limit is null or _limit<1 or _limit>200 then
  raise exception 'Choose a date and a valid page (1–200 records)' using errcode='22023';
 end if;
 if length(coalesce(_search,''))>200 then raise exception 'Search must be 200 characters or less' using errcode='22023'; end if;
 if _employee_id is not null then
  select user_id into worker_user from public.employees where id=_employee_id;
  if not found then raise exception 'Worker not found' using errcode='22023'; end if;
 end if;
 start_at:=_day::timestamp at time zone 'America/New_York';
 end_at:=(_day+1)::timestamp at time zone 'America/New_York';
 if _shift_id is not null then
  select * into chosen from public.time_entries where id=_shift_id and employee_id=_employee_id;
  if not found then raise exception 'This shift does not belong to the selected worker' using errcode='22023'; end if;
  start_at:=chosen.clock_in;
  end_at:=coalesce(chosen.clock_out,snapshot_at);
 end if;
 with base as materialized (
  select e.* from public.admin_work_event_stream e
  where e.actor_user_id is not null and (_employee_id is null or e.actor_user_id=worker_user)
   and e.occurred_at>=start_at and e.occurred_at<=snapshot_at
   and (e.occurred_at<end_at or (_shift_id is not null and e.source='clock_out' and e.entity_id=_shift_id::text and e.occurred_at=end_at))
 ), counts as (
  select actor_user_id,count(*) records,min(occurred_at) first_at,max(occurred_at) last_at from base group by actor_user_id
 ), metric_counts as (
  select actor_user_id,metric,case when metric='units_checked_in' then sum(quantity)
   else count(distinct case when category='tasks' then source||':'||(details->>'task_id')
     when metric='pending_orders_closed' then entity_id
     when metric='replies_sent' then coalesce(details->>'send_attempt_id',event_key)
     when category='packaging' then coalesce(details->>'shipment_id',event_key)
     else event_key end) end n
  from base where metric is not null group by actor_user_id,metric
 ), metrics as (
  select actor_user_id,jsonb_object_agg(metric,n) data from metric_counts group by actor_user_id
 ), category_counts as (
  select actor_user_id,category,count(*) n from base group by actor_user_id,category
 ), categories as (
  select actor_user_id,jsonb_object_agg(category,n) data from category_counts group by actor_user_id
 ), shift_rows as (
  select t.id,t.employee_id,t.clock_in,t.clock_out,s.name store,
   greatest(0,extract(epoch from least(coalesce(t.clock_out,snapshot_at),snapshot_at,end_at)-greatest(t.clock_in,start_at))) clocked_seconds,
   coalesce((select sum(greatest(0,extract(epoch from least(coalesce(b.ended_at,snapshot_at),coalesce(t.clock_out,snapshot_at),snapshot_at,end_at)-greatest(b.started_at,t.clock_in,start_at))))
    from public.time_breaks b where b.time_entry_id=t.id and b.started_at<least(coalesce(t.clock_out,snapshot_at),snapshot_at,end_at) and coalesce(b.ended_at,snapshot_at)>greatest(t.clock_in,start_at)),0) break_seconds,
   (select count(*) from public.time_entry_admin_audits a where a.time_entry_id=t.id)+(select count(*) from public.shift_adjustments a where a.time_entry_id=t.id) correction_count
  from public.time_entries t left join public.store_locations s on s.id=t.store_id
  where (_employee_id is null or t.employee_id=_employee_id)
   and t.clock_in<end_at and t.clock_in<=snapshot_at and coalesce(t.clock_out,snapshot_at)>=start_at
   and (_shift_id is null or t.id=_shift_id)
 ), shift_groups as (
  select employee_id,jsonb_agg(to_jsonb(s) order by clock_in,id) data,sum(clocked_seconds) clocked_seconds,sum(break_seconds) break_seconds from shift_rows s group by employee_id
 ), workers as (
  select w.id,w.display_name,w.email,w.active,coalesce(c.records,0) records,c.first_at,c.last_at,
   coalesce(m.data,'{}') metrics,coalesce(g.data,'{}') categories,coalesce(s.data,'[]') shifts,
   coalesce(s.clocked_seconds,0) clocked_seconds,coalesce(s.break_seconds,0) break_seconds
  from public.employees w left join counts c on c.actor_user_id=w.user_id
   left join metrics m on m.actor_user_id=w.user_id left join categories g on g.actor_user_id=w.user_id
   left join shift_groups s on s.employee_id=w.id
  where (_employee_id is null or w.id=_employee_id) and (w.active or c.records>0 or s.employee_id is not null or w.id=_employee_id)
 ), filtered as (
  select * from base where (nullif(_category,'') is null or category=_category)
   and (nullif(btrim(_search),'') is null or strpos(lower(concat_ws(' ',title,notes,action,details::text)),lower(btrim(_search)))>0)
 ), page as (
  select * from filtered order by occurred_at desc,event_key desc limit _limit offset _offset
 )
 select jsonb_build_object('day',_day,'time_zone','America/New_York','as_of',snapshot_at,'start_at',start_at,'end_at',end_at,
  'shift_id',_shift_id,'workers',coalesce((select jsonb_agg(to_jsonb(w) order by lower(coalesce(nullif(w.display_name,''),w.email)),w.id) from workers w),'[]'),
  'total',case when _employee_id is not null then (select count(*) from filtered) else 0 end,
  'unattributed_records',(select count(*) from base b where not exists(select 1 from public.employees w where w.user_id=b.actor_user_id)),
  'events',case when _employee_id is not null then coalesce((select jsonb_agg(to_jsonb(p) order by occurred_at desc,event_key desc) from page p),'[]') else '[]'::jsonb end)
 into result;
 return result;
end $$;
revoke all on function public.admin_employee_work_report(date,uuid,uuid,text,text,integer,integer,timestamptz) from public,anon;
grant execute on function public.admin_employee_work_report(date,uuid,uuid,text,text,integer,integer,timestamptz) to authenticated;
comment on function public.admin_employee_work_report(date,uuid,uuid,text,text,integer,integer,timestamptz) is
 'Admin-only, actor-attributed daily/shift work evidence. New York calendar boundaries, full-range totals and stable timestamp/key pagination. Related audit records are not independent completed jobs.';
commit;
