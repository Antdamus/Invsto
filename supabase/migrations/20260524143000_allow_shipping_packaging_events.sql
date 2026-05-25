-- Allow shipping workers to record packaging handoff/self-packaging events.

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
    'completed_by_employee',
    'sent_back_for_rework',
    'approved_by_admin',
    'approved_for_shipping',
    'shipment_assigned',
    'shipping_handoff',
    'shipping_ready_for_packaging',
    'packaging_assigned',
    'shipped_completed'
  ));
