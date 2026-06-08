-- Step 5F.6P provider-aware eBay read/unread state.
-- eBay provider state is tracked separately from OG's local/operator state so
-- the UI can be honest when local reads have not yet been pushed to eBay.

alter table public.ebay_conversations
  add column if not exists provider_read_state text,
  add column if not exists local_read_state text,
  add column if not exists pending_provider_update boolean not null default false,
  add column if not exists last_provider_seen_at timestamptz,
  add column if not exists last_local_read_at timestamptz,
  add column if not exists last_read_sync_at timestamptz,
  add column if not exists read_sync_status text,
  add column if not exists read_sync_error text;

update public.ebay_conversations
set
  provider_read_state = coalesce(
    provider_read_state,
    case when coalesce(unread_count, 0) > 0 then 'unread' else 'read' end
  ),
  local_read_state = coalesce(
    local_read_state,
    case when coalesce(unread_count, 0) > 0 then 'unread' else 'read' end
  ),
  last_provider_seen_at = coalesce(last_provider_seen_at, last_synced_at, last_seen_at, updated_at, created_at, now()),
  last_read_sync_at = coalesce(last_read_sync_at, last_synced_at, last_seen_at, updated_at, created_at, now()),
  read_sync_status = coalesce(read_sync_status, 'synced');

alter table public.ebay_conversations
  alter column provider_read_state set default 'unknown',
  alter column provider_read_state set not null,
  alter column local_read_state set default 'unknown',
  alter column local_read_state set not null,
  alter column read_sync_status set default 'unknown',
  alter column read_sync_status set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'ebay_conversations_provider_read_state_check'
  ) then
    alter table public.ebay_conversations
      add constraint ebay_conversations_provider_read_state_check
      check (provider_read_state in ('read', 'unread', 'unknown'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'ebay_conversations_local_read_state_check'
  ) then
    alter table public.ebay_conversations
      add constraint ebay_conversations_local_read_state_check
      check (local_read_state in ('read', 'unread', 'unknown'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'ebay_conversations_read_sync_status_check'
  ) then
    alter table public.ebay_conversations
      add constraint ebay_conversations_read_sync_status_check
      check (read_sync_status in (
        'synced',
        'local_only',
        'pending_provider_update',
        'provider_update_succeeded',
        'provider_update_failed',
        'provider_unsupported',
        'unknown'
      ));
  end if;
end;
$$;

create index if not exists ebay_conversations_provider_read_state_idx
  on public.ebay_conversations(seller_account_id, provider_read_state, last_provider_seen_at desc nulls last);

create index if not exists ebay_conversations_local_read_state_idx
  on public.ebay_conversations(seller_account_id, local_read_state, updated_at desc);

create index if not exists ebay_conversations_pending_provider_update_idx
  on public.ebay_conversations(seller_account_id, pending_provider_update, updated_at desc)
  where pending_provider_update = true;

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
    'message_backfill_failed',
    'read_state_synced',
    'read_state_sync_failed',
    'provider_notification_received'
  ));

create or replace function public.mark_ebay_conversation_read(_conversation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_previous_unread integer := 0;
  v_messages_updated integer := 0;
  v_provider_read_state text := 'unknown';
  v_pending_provider_update boolean := false;
  v_read_sync_status text := 'local_only';
begin
  if not public.is_admin() then
    raise exception 'Admin privileges are required to mark eBay conversations read'
      using errcode = '42501';
  end if;

  select coalesce(unread_count, 0), coalesce(provider_read_state, 'unknown')
    into v_previous_unread, v_provider_read_state
  from public.ebay_conversations
  where id = _conversation_id;

  if not found then
    raise exception 'eBay conversation not found'
      using errcode = 'P0002';
  end if;

  v_pending_provider_update := v_provider_read_state is distinct from 'read';
  v_read_sync_status := case
    when v_pending_provider_update then 'pending_provider_update'
    else 'synced'
  end;

  update public.ebay_conversations
  set
    unread_count = 0,
    local_read_state = 'read',
    pending_provider_update = v_pending_provider_update,
    last_local_read_at = now(),
    read_sync_status = v_read_sync_status,
    read_sync_error = null,
    updated_at = now()
  where id = _conversation_id;

  update public.ebay_conversation_messages
  set
    read_status = 'Read',
    is_read = true,
    updated_at = now()
  where conversation_id = _conversation_id
    and (
      is_read is distinct from true
      or coalesce(read_status, '') <> 'Read'
    );
  get diagnostics v_messages_updated = row_count;

  return jsonb_build_object(
    'ok', true,
    'conversation_id', _conversation_id,
    'previous_unread_count', v_previous_unread,
    'unread_count', 0,
    'provider_read_state', v_provider_read_state,
    'local_read_state', 'read',
    'pending_provider_update', v_pending_provider_update,
    'read_sync_status', v_read_sync_status,
    'messages_updated', v_messages_updated,
    'local_only', true
  );
end;
$$;

grant execute on function public.mark_ebay_conversation_read(uuid) to authenticated;

create or replace function public.mark_ebay_conversation_unread(_conversation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_previous_unread integer := 0;
  v_provider_read_state text := 'unknown';
  v_pending_provider_update boolean := false;
  v_read_sync_status text := 'local_only';
begin
  if not public.is_admin() then
    raise exception 'Admin privileges are required to mark eBay conversations unread'
      using errcode = '42501';
  end if;

  select coalesce(unread_count, 0), coalesce(provider_read_state, 'unknown')
    into v_previous_unread, v_provider_read_state
  from public.ebay_conversations
  where id = _conversation_id;

  if not found then
    raise exception 'eBay conversation not found'
      using errcode = 'P0002';
  end if;

  v_pending_provider_update := v_provider_read_state is distinct from 'unread';
  v_read_sync_status := case
    when v_pending_provider_update then 'pending_provider_update'
    else 'synced'
  end;

  update public.ebay_conversations
  set
    unread_count = greatest(coalesce(unread_count, 0), 1),
    local_read_state = 'unread',
    pending_provider_update = v_pending_provider_update,
    last_local_read_at = now(),
    read_sync_status = v_read_sync_status,
    read_sync_error = null,
    updated_at = now()
  where id = _conversation_id;

  return jsonb_build_object(
    'ok', true,
    'conversation_id', _conversation_id,
    'previous_unread_count', v_previous_unread,
    'unread_count', greatest(v_previous_unread, 1),
    'provider_read_state', v_provider_read_state,
    'local_read_state', 'unread',
    'pending_provider_update', v_pending_provider_update,
    'read_sync_status', v_read_sync_status,
    'local_only', true
  );
end;
$$;

grant execute on function public.mark_ebay_conversation_unread(uuid) to authenticated;

comment on column public.ebay_conversations.provider_read_state
  is 'Last read/unread state observed from eBay Commerce Message API or confirmed by a provider update.';

comment on column public.ebay_conversations.local_read_state
  is 'OG operator-facing read/unread state. This may differ from provider_read_state while pending_provider_update is true.';

comment on column public.ebay_conversations.pending_provider_update
  is 'True when OG local_read_state should be pushed to eBay but provider confirmation has not happened.';

comment on column public.ebay_conversations.read_sync_status
  is 'Read/unread reconciliation lifecycle for the provider/local state pair.';
