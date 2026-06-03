-- Step 5F.6O historical eBay message backfill foundation.
-- Adds restartable checkpoints, aggregate backfill dashboard events, and
-- read-only archive integrity checks.

create table if not exists public.ebay_message_sync_checkpoints (
  id uuid primary key default gen_random_uuid(),
  seller_account_id uuid not null references public.ebay_seller_accounts(id) on delete cascade,
  checkpoint_scope text not null default 'commerce_message_archive',
  conversation_type text not null
    check (conversation_type in ('FROM_MEMBERS', 'FROM_EBAY')),
  status text not null default 'idle'
    check (status in ('idle', 'running', 'succeeded', 'failed', 'cancelled')),
  current_run_id uuid references public.ebay_message_sync_runs(id) on delete set null,
  last_run_id uuid references public.ebay_message_sync_runs(id) on delete set null,
  last_full_backfill_at timestamptz,
  last_successful_sync_at timestamptz,
  last_conversation_timestamp timestamptz,
  last_page_processed integer,
  next_offset integer not null default 0 check (next_offset >= 0),
  total_available integer check (total_available is null or total_available >= 0),
  pages_processed integer not null default 0 check (pages_processed >= 0),
  conversations_processed integer not null default 0 check (conversations_processed >= 0),
  messages_processed integer not null default 0 check (messages_processed >= 0),
  last_error_code text,
  last_error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (seller_account_id, checkpoint_scope, conversation_type)
);

create index if not exists ebay_message_sync_checkpoints_status_idx
  on public.ebay_message_sync_checkpoints(status, updated_at desc);

create index if not exists ebay_message_sync_checkpoints_account_scope_idx
  on public.ebay_message_sync_checkpoints(seller_account_id, checkpoint_scope, updated_at desc);

alter table public.ebay_message_sync_checkpoints enable row level security;

revoke all on table public.ebay_message_sync_checkpoints from public, anon, authenticated;
grant select on table public.ebay_message_sync_checkpoints to authenticated;
grant select, insert, update, delete on table public.ebay_message_sync_checkpoints to service_role;

drop policy if exists "ebay_message_sync_checkpoints_staff_select" on public.ebay_message_sync_checkpoints;
create policy "ebay_message_sync_checkpoints_staff_select"
on public.ebay_message_sync_checkpoints
for select
to authenticated
using (public.can_manage_inventory());

drop trigger if exists trg_ebay_message_sync_checkpoints_updated_at on public.ebay_message_sync_checkpoints;
create trigger trg_ebay_message_sync_checkpoints_updated_at
before update on public.ebay_message_sync_checkpoints
for each row execute function public.touch_ebay_messaging_updated_at();

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

create or replace function public.validate_ebay_message_archive_integrity(_seller_account_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_duplicate_conversation_keys integer := 0;
  v_duplicate_message_keys integer := 0;
  v_messages_without_conversation integer := 0;
  v_links_without_conversation integer := 0;
  v_classifications_without_conversation integer := 0;
  v_latest_message_missing integer := 0;
  v_context_links_without_target integer := 0;
  v_multiple_current_classifications integer := 0;
begin
  if not public.can_manage_inventory() and not public.is_admin() then
    raise exception 'Admin privileges are required to validate eBay message archive integrity'
      using errcode = '42501';
  end if;

  select count(*)
    into v_duplicate_conversation_keys
  from (
    select seller_account_id, conversation_type, ebay_conversation_id
    from public.ebay_conversations
    where _seller_account_id is null or seller_account_id = _seller_account_id
    group by seller_account_id, conversation_type, ebay_conversation_id
    having count(*) > 1
  ) duplicate_keys;

  select count(*)
    into v_duplicate_message_keys
  from (
    select seller_account_id, conversation_type, ebay_conversation_id, ebay_message_id
    from public.ebay_conversation_messages
    where _seller_account_id is null or seller_account_id = _seller_account_id
    group by seller_account_id, conversation_type, ebay_conversation_id, ebay_message_id
    having count(*) > 1
  ) duplicate_keys;

  select count(*)
    into v_messages_without_conversation
  from public.ebay_conversation_messages m
  left join public.ebay_conversations c on c.id = m.conversation_id
  where c.id is null
    and (_seller_account_id is null or m.seller_account_id = _seller_account_id);

  select count(*)
    into v_links_without_conversation
  from public.ebay_conversation_links l
  left join public.ebay_conversations c on c.id = l.conversation_id
  where c.id is null
    and (_seller_account_id is null or l.seller_account_id = _seller_account_id);

  select count(*)
    into v_classifications_without_conversation
  from public.ebay_conversation_classifications cl
  left join public.ebay_conversations c on c.id = cl.conversation_id
  where c.id is null
    and (_seller_account_id is null or c.seller_account_id = _seller_account_id);

  select count(*)
    into v_latest_message_missing
  from public.ebay_conversations c
  where c.latest_message_id is not null
    and (_seller_account_id is null or c.seller_account_id = _seller_account_id)
    and not exists (
      select 1
      from public.ebay_conversation_messages m
      where m.conversation_id = c.id
        and m.ebay_message_id = c.latest_message_id
    );

  select count(*)
    into v_context_links_without_target
  from public.ebay_conversation_links l
  where (_seller_account_id is null or l.seller_account_id = _seller_account_id)
    and (
      (l.link_type = 'ebay_order' and l.ebay_order_id is null)
      or (l.link_type = 'ebay_order_line' and l.ebay_order_line_id is null)
      or (l.link_type = 'ebay_return_case' and l.ebay_return_case_id is null)
    );

  select count(*)
    into v_multiple_current_classifications
  from (
    select conversation_id
    from public.ebay_conversation_classifications
    where is_current = true
    group by conversation_id
    having count(*) > 1
  ) current_duplicates
  join public.ebay_conversations c on c.id = current_duplicates.conversation_id
  where _seller_account_id is null or c.seller_account_id = _seller_account_id;

  return jsonb_build_object(
    'ok',
    (
      v_duplicate_conversation_keys = 0
      and v_duplicate_message_keys = 0
      and v_messages_without_conversation = 0
      and v_links_without_conversation = 0
      and v_classifications_without_conversation = 0
      and v_latest_message_missing = 0
      and v_context_links_without_target = 0
      and v_multiple_current_classifications = 0
    ),
    'checked_at', now(),
    'seller_account_id', _seller_account_id,
    'duplicate_conversation_keys', v_duplicate_conversation_keys,
    'duplicate_message_keys', v_duplicate_message_keys,
    'messages_without_conversation', v_messages_without_conversation,
    'links_without_conversation', v_links_without_conversation,
    'classifications_without_conversation', v_classifications_without_conversation,
    'latest_message_missing', v_latest_message_missing,
    'context_links_without_target', v_context_links_without_target,
    'multiple_current_classifications', v_multiple_current_classifications
  );
end;
$$;

grant execute on function public.validate_ebay_message_archive_integrity(uuid) to authenticated;

comment on table public.ebay_message_sync_checkpoints
  is 'Restartable eBay Commerce Message archive checkpoints by seller account and conversation type.';

comment on function public.validate_ebay_message_archive_integrity(uuid)
  is 'Read-only integrity validation for canonical eBay conversations, messages, links, and classifications.';
