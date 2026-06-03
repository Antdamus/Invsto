-- Step 5F.6O.2 chunked historical eBay message backfill.
-- Backfill checkpoints can pause cleanly between chunks, and each chunk emits
-- one aggregate progress/completion/failure dashboard event.

do $$
declare
  v_constraint text;
begin
  for v_constraint in
    select c.conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'ebay_message_sync_checkpoints'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) like '%status%'
  loop
    execute format('alter table public.ebay_message_sync_checkpoints drop constraint %I', v_constraint);
  end loop;
end;
$$;

alter table public.ebay_message_sync_checkpoints
  add constraint ebay_message_sync_checkpoints_status_check
  check (status in ('idle', 'running', 'paused', 'succeeded', 'failed', 'cancelled'));

do $$
declare
  v_constraint text;
begin
  for v_constraint in
    select c.conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'ebay_message_activity_events'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) like '%event_type%'
  loop
    execute format('alter table public.ebay_message_activity_events drop constraint %I', v_constraint);
  end loop;
end;
$$;

alter table public.ebay_message_activity_events
  add constraint ebay_message_activity_events_event_type_check
  check (event_type in (
    'conversation_synced',
    'conversation_classified',
    'classification_changed',
    'draft_generated',
    'draft_improved',
    'draft_edited',
    'draft_discarded',
    'draft_approved',
    'approval_removed',
    'send_attempt_created',
    'send_attempt_failed',
    'send_attempt_succeeded',
    'duplicate_send_prevented',
    'smart_folder_created',
    'smart_folder_updated',
    'message_sync_completed',
    'message_sync_failed',
    'message_backfill_started',
    'message_backfill_progress',
    'message_backfill_completed',
    'message_backfill_failed'
  ));

comment on table public.ebay_message_sync_checkpoints
  is 'Restartable eBay Commerce Message archive checkpoints by seller account and conversation type. Status paused means a healthy chunk finished before archive exhaustion.';
