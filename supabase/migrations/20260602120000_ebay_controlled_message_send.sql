-- Controlled eBay Commerce Message send support.
-- Extends the existing append-only audit model; does not create a second
-- approval system.

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
      and t.relname = 'ebay_conversation_response_drafts'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) like '%draft_status%'
  loop
    execute format('alter table public.ebay_conversation_response_drafts drop constraint %I', v_constraint);
  end loop;
end;
$$;

alter table public.ebay_conversation_response_drafts
  add constraint ebay_conversation_response_drafts_draft_status_check
  check (draft_status in ('generated', 'edited', 'saved', 'discarded', 'superseded', 'error', 'sent'));

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
    'smart_folder_updated'
  ));

create or replace function public.log_ebay_send_attempt_activity()
returns trigger
language plpgsql
as $$
declare
  v_event_type text;
begin
  if tg_op = 'INSERT' then
    v_event_type := case
      when new.attempt_status = 'succeeded' then 'send_attempt_succeeded'
      when new.attempt_status = 'failed' then 'send_attempt_failed'
      when new.attempt_status = 'duplicate' then 'duplicate_send_prevented'
      else 'send_attempt_created'
    end;
  elsif new.attempt_status is distinct from old.attempt_status then
    v_event_type := case
      when new.attempt_status = 'succeeded' then 'send_attempt_succeeded'
      when new.attempt_status = 'failed' then 'send_attempt_failed'
      when new.attempt_status = 'duplicate' then 'duplicate_send_prevented'
      else null
    end;
  end if;

  if v_event_type is not null then
    perform public.record_ebay_message_activity_event(
      v_event_type,
      case
        when new.attempt_status = 'failed' then 'failed'
        when new.attempt_status = 'succeeded' then 'succeeded'
        when new.attempt_status = 'duplicate' then 'blocked'
        else 'pending'
      end,
      new.created_by,
      null,
      new.conversation_id,
      new.target_message_id,
      new.draft_id,
      new.approval_id,
      new.id,
      null,
      null,
      null,
      v_event_type || ':' || new.id::text || ':' || new.attempt_status,
      case
        when v_event_type = 'send_attempt_succeeded' then 'Message sent'
        when v_event_type = 'send_attempt_failed' then 'Send failed'
        when v_event_type = 'duplicate_send_prevented' then 'Duplicate send prevented'
        else 'Send attempt created'
      end,
      new.error_message,
      jsonb_build_object(
        'attempt_status', new.attempt_status,
        'provider', new.provider,
        'provider_message_id', new.provider_message_id,
        'provider_correlation_id', new.provider_correlation_id,
        'idempotency_key', new.idempotency_key,
        'attempt_sequence', new.attempt_sequence,
        'duplicate_of_attempt_id', new.duplicate_of_attempt_id
      )
    );
  end if;

  return new;
end;
$$;

comment on table public.ebay_message_send_attempts
  is 'Controlled-send attempt ledger. Human-approved draft sends share a logical idempotency key; duplicate and in-flight sends are blocked before another provider call.';
