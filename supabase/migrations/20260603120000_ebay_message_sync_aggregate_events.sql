-- Step 5F.6O.1 aggregate eBay message sync dashboard events.
-- Batch sync runs emit one aggregate dashboard event; single-conversation
-- refreshes keep the individual conversation_synced event.

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
    'message_backfill_completed',
    'message_backfill_failed'
  ));

create or replace function public.log_ebay_conversation_sync_activity()
returns trigger
language plpgsql
as $$
declare
  v_run_type text;
  v_run_metadata jsonb;
begin
  if new.last_sync_run_id is not null then
    select run_type, metadata
      into v_run_type, v_run_metadata
    from public.ebay_message_sync_runs
    where id = new.last_sync_run_id;

    if v_run_type = 'backfill'
      or lower(coalesce(v_run_metadata ->> 'suppress_conversation_activity_events', 'false')) in ('true', '1', 'yes')
    then
      return new;
    end if;
  end if;

  if tg_op = 'INSERT'
    or new.last_synced_at is distinct from old.last_synced_at
    or new.last_detail_synced_at is distinct from old.last_detail_synced_at
  then
    perform public.record_ebay_message_activity_event(
      'conversation_synced',
      'succeeded',
      null,
      null,
      new.id,
      null,
      null,
      null,
      null,
      null,
      null,
      new.last_sync_run_id,
      'conversation_synced:' || new.id::text || ':' || coalesce(new.last_detail_synced_at::text, new.last_synced_at::text, new.updated_at::text, new.created_at::text),
      'Conversation synced',
      coalesce(new.ebay_conversation_id, new.conversation_title, new.other_party_username),
      jsonb_build_object(
        'ebay_conversation_id', new.ebay_conversation_id,
        'conversation_type', new.conversation_type,
        'unread_count', new.unread_count,
        'latest_message_id', new.latest_message_id
      )
    );
  end if;

  return new;
end;
$$;

comment on function public.log_ebay_conversation_sync_activity()
  is 'Records individual conversation sync events only for single-conversation operations; batch syncs use aggregate Edge Function events.';
