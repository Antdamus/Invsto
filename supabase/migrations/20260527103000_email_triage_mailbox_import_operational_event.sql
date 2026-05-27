-- Step 5F.1: allow mailbox import runs to write first-class operational
-- events. This only extends the existing audit event allow-list.

do $$
declare
  existing_constraint record;
begin
  for existing_constraint in
    select conname
    from pg_constraint
    where conrelid = 'public.email_operational_events'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%event_type%'
  loop
    execute format('alter table public.email_operational_events drop constraint %I', existing_constraint.conname);
  end loop;

  alter table public.email_operational_events
    add constraint email_operational_events_event_type_check
    check (event_type in (
      'processing_requeue',
      'processing_replay',
      'sync_replay',
      'classification_replay',
      'sync_import_approved',
      'process_imported',
      'classify_imported',
      'set_live_sync',
      'run_live_refresh',
      'rematch_existing',
      'mailbox_import'
    ));
end $$;
