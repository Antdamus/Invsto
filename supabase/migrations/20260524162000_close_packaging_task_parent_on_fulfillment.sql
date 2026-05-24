-- Keep the parent pending-order workflow in history when the final
-- shipping or packaging task is completed from Pending Orders.

alter table public.ebay_order_task_events
  drop constraint if exists ebay_order_task_events_action_check;

alter table public.ebay_order_task_events
  add constraint ebay_order_task_events_action_check
  check (action in (
    'created',
    'assigned',
    'status_changed',
    'commented',
    'resolved',
    'cancelled',
    'subtask_created',
    'progress_update',
    'reassign_requested',
    'completed_by_employee',
    'sent_back_for_rework',
    'approved_by_admin',
    'approved_for_shipping',
    'shipment_assigned',
    'shipping_ready_for_packaging',
    'shipping_handoff',
    'packaging_assigned',
    'shipped_completed'
  ));

create or replace function public.close_parent_ebay_order_task_after_shipping_completion()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.parent_task_id is not null
    and new.task_type in ('pending_shipping', 'pending_packaging')
    and new.status = 'shipped_completed'
    and old.status is distinct from new.status
  then
    update public.ebay_order_tasks
    set status = 'shipped_completed',
        completed_at = coalesce(new.completed_at, now()),
        resolved_at = coalesce(new.resolved_at, now()),
        resolved_by = coalesce(new.resolved_by, auth.uid()),
        resolved_by_email = coalesce(new.resolved_by_email, new.assigned_to_email),
        resolution_notes = coalesce(new.resolution_notes, new.latest_note, 'Shipment completed.'),
        latest_note = coalesce(new.latest_note, 'Shipment completed.'),
        updated_at = now()
    where id = new.parent_task_id
      and status not in ('shipped_completed', 'closed', 'cancelled');
  end if;

  return new;
end;
$$;

drop trigger if exists trg_close_parent_ebay_order_task_after_shipping_completion
  on public.ebay_order_tasks;

create trigger trg_close_parent_ebay_order_task_after_shipping_completion
after update of status on public.ebay_order_tasks
for each row
execute function public.close_parent_ebay_order_task_after_shipping_completion();
