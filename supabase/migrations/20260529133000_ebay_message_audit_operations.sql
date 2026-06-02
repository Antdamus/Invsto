-- eBay message send-safety foundation.
-- This migration adds approval history, future send-attempt tracking, and an
-- eBay-native operational activity feed. It does not send messages or mutate eBay.

create table if not exists public.ebay_message_approvals (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.ebay_conversations(id) on delete cascade,
  target_message_id uuid references public.ebay_conversation_messages(id) on delete set null,
  draft_id uuid not null references public.ebay_conversation_response_drafts(id) on delete cascade,
  approval_status text not null
    check (approval_status in ('approved', 'approval_removed')),
  approved_by uuid references auth.users(id) on delete set null,
  approved_by_email text,
  approved_at timestamptz,
  approval_notes text,
  removed_by uuid references auth.users(id) on delete set null,
  removed_by_email text,
  removed_at timestamptz,
  removal_notes text,
  previous_approval_id uuid references public.ebay_message_approvals(id) on delete set null,
  idempotency_key text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint ebay_message_approvals_approved_fields_check
    check (
      (approval_status = 'approved' and approved_at is not null)
      or (approval_status = 'approval_removed' and removed_at is not null)
    )
);

create table if not exists public.ebay_message_send_attempts (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.ebay_conversations(id) on delete cascade,
  target_message_id uuid references public.ebay_conversation_messages(id) on delete set null,
  draft_id uuid not null references public.ebay_conversation_response_drafts(id) on delete cascade,
  approval_id uuid references public.ebay_message_approvals(id) on delete restrict,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  approval_notes text,
  attempt_status text not null default 'created'
    check (attempt_status in ('created', 'ready_to_send', 'sending', 'succeeded', 'failed', 'cancelled', 'blocked', 'duplicate')),
  provider text not null default 'ebay_commerce_message'
    check (provider in ('ebay_commerce_message', 'ebay_return', 'outlook_relay', 'manual', 'unknown')),
  provider_message_id text,
  provider_correlation_id text,
  idempotency_key text not null,
  attempt_sequence integer not null default 1 check (attempt_sequence > 0),
  duplicate_of_attempt_id uuid references public.ebay_message_send_attempts(id) on delete set null,
  error_message text,
  provider_response jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  sent_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ebay_message_activity_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null
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
      'smart_folder_created',
      'smart_folder_updated'
    )),
  status text not null default 'recorded'
    check (status in ('recorded', 'pending', 'succeeded', 'failed', 'warning', 'blocked')),
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_email text,
  conversation_id uuid references public.ebay_conversations(id) on delete set null,
  target_message_id uuid references public.ebay_conversation_messages(id) on delete set null,
  draft_id uuid references public.ebay_conversation_response_drafts(id) on delete set null,
  approval_id uuid references public.ebay_message_approvals(id) on delete set null,
  send_attempt_id uuid references public.ebay_message_send_attempts(id) on delete set null,
  classification_id uuid references public.ebay_conversation_classifications(id) on delete set null,
  saved_view_id uuid references public.ebay_conversation_saved_views(id) on delete set null,
  sync_run_id uuid references public.ebay_message_sync_runs(id) on delete set null,
  idempotency_key text,
  title text,
  detail text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ebay_message_approvals_draft_created_idx
  on public.ebay_message_approvals(draft_id, created_at desc);

create index if not exists ebay_message_approvals_conversation_created_idx
  on public.ebay_message_approvals(conversation_id, created_at desc);

create index if not exists ebay_message_approvals_target_created_idx
  on public.ebay_message_approvals(target_message_id, created_at desc)
  where target_message_id is not null;

create unique index if not exists ebay_message_approvals_idempotency_key_uidx
  on public.ebay_message_approvals(idempotency_key)
  where idempotency_key is not null;

create index if not exists ebay_message_send_attempts_draft_created_idx
  on public.ebay_message_send_attempts(draft_id, created_at desc);

create index if not exists ebay_message_send_attempts_conversation_created_idx
  on public.ebay_message_send_attempts(conversation_id, created_at desc);

create index if not exists ebay_message_send_attempts_approval_idx
  on public.ebay_message_send_attempts(approval_id, created_at desc)
  where approval_id is not null;

create index if not exists ebay_message_send_attempts_idempotency_idx
  on public.ebay_message_send_attempts(idempotency_key, attempt_sequence);

create unique index if not exists ebay_message_send_attempts_sequence_uidx
  on public.ebay_message_send_attempts(idempotency_key, attempt_sequence);

create unique index if not exists ebay_message_send_attempts_one_success_uidx
  on public.ebay_message_send_attempts(idempotency_key)
  where attempt_status = 'succeeded';

create unique index if not exists ebay_message_send_attempts_provider_message_uidx
  on public.ebay_message_send_attempts(provider, provider_message_id)
  where provider_message_id is not null;

create index if not exists ebay_message_activity_events_created_idx
  on public.ebay_message_activity_events(created_at desc);

create index if not exists ebay_message_activity_events_type_created_idx
  on public.ebay_message_activity_events(event_type, created_at desc);

create index if not exists ebay_message_activity_events_conversation_created_idx
  on public.ebay_message_activity_events(conversation_id, created_at desc)
  where conversation_id is not null;

create index if not exists ebay_message_activity_events_draft_created_idx
  on public.ebay_message_activity_events(draft_id, created_at desc)
  where draft_id is not null;

create unique index if not exists ebay_message_activity_events_idempotency_key_uidx
  on public.ebay_message_activity_events(idempotency_key)
  where idempotency_key is not null;

alter table public.ebay_message_approvals enable row level security;
alter table public.ebay_message_send_attempts enable row level security;
alter table public.ebay_message_activity_events enable row level security;

revoke all on table public.ebay_message_approvals from public, anon, authenticated;
revoke all on table public.ebay_message_send_attempts from public, anon, authenticated;
revoke all on table public.ebay_message_activity_events from public, anon, authenticated;

grant select on table public.ebay_message_approvals to authenticated;
grant select on table public.ebay_message_send_attempts to authenticated;
grant select on table public.ebay_message_activity_events to authenticated;

grant select, insert on table public.ebay_message_approvals to service_role;
grant select, insert, update on table public.ebay_message_send_attempts to service_role;
grant select, insert on table public.ebay_message_activity_events to service_role;

drop policy if exists "ebay_message_approvals_staff_select" on public.ebay_message_approvals;
create policy "ebay_message_approvals_staff_select"
on public.ebay_message_approvals
for select
to authenticated
using (public.can_manage_inventory());

drop policy if exists "ebay_message_send_attempts_staff_select" on public.ebay_message_send_attempts;
create policy "ebay_message_send_attempts_staff_select"
on public.ebay_message_send_attempts
for select
to authenticated
using (public.can_manage_inventory());

drop policy if exists "ebay_message_activity_events_staff_select" on public.ebay_message_activity_events;
create policy "ebay_message_activity_events_staff_select"
on public.ebay_message_activity_events
for select
to authenticated
using (public.can_manage_inventory());

create or replace function public.ebay_message_activity_actor_email(actor_id uuid)
returns text
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_email text;
begin
  if actor_id is null then
    return null;
  end if;

  select u.email
  into v_email
  from auth.users u
  where u.id = actor_id;

  return v_email;
exception
  when others then
    return null;
end;
$$;

create or replace function public.record_ebay_message_activity_event(
  _event_type text,
  _status text default 'recorded',
  _actor_user_id uuid default null,
  _actor_email text default null,
  _conversation_id uuid default null,
  _target_message_id uuid default null,
  _draft_id uuid default null,
  _approval_id uuid default null,
  _send_attempt_id uuid default null,
  _classification_id uuid default null,
  _saved_view_id uuid default null,
  _sync_run_id uuid default null,
  _idempotency_key text default null,
  _title text default null,
  _detail text default null,
  _metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into public.ebay_message_activity_events (
    id,
    event_type,
    status,
    actor_user_id,
    actor_email,
    conversation_id,
    target_message_id,
    draft_id,
    approval_id,
    send_attempt_id,
    classification_id,
    saved_view_id,
    sync_run_id,
    idempotency_key,
    title,
    detail,
    metadata
  )
  values (
    v_id,
    _event_type,
    coalesce(_status, 'recorded'),
    _actor_user_id,
    coalesce(_actor_email, public.ebay_message_activity_actor_email(_actor_user_id)),
    _conversation_id,
    _target_message_id,
    _draft_id,
    _approval_id,
    _send_attempt_id,
    _classification_id,
    _saved_view_id,
    _sync_run_id,
    _idempotency_key,
    _title,
    _detail,
    coalesce(_metadata, '{}'::jsonb)
  )
  on conflict do nothing;

  return v_id;
end;
$$;

create or replace function public.prevent_ebay_message_activity_event_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'ebay_message_activity_events is immutable';
end;
$$;

create or replace function public.prevent_ebay_message_approval_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'ebay_message_approvals is append-only';
end;
$$;

create or replace function public.protect_ebay_message_send_attempt_identity()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'ebay_message_send_attempts cannot be deleted';
  end if;

  if old.conversation_id is distinct from new.conversation_id
    or old.target_message_id is distinct from new.target_message_id
    or old.draft_id is distinct from new.draft_id
    or old.approval_id is distinct from new.approval_id
    or old.provider is distinct from new.provider
    or old.idempotency_key is distinct from new.idempotency_key
    or old.attempt_sequence is distinct from new.attempt_sequence
  then
    raise exception 'ebay_message_send_attempt identity fields cannot be changed';
  end if;

  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.log_ebay_conversation_sync_activity()
returns trigger
language plpgsql
as $$
begin
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

create or replace function public.log_ebay_classification_activity()
returns trigger
language plpgsql
as $$
begin
  perform public.record_ebay_message_activity_event(
    'conversation_classified',
    case when new.classification_status = 'failed' then 'failed' else 'succeeded' end,
    new.created_by,
    null,
    new.conversation_id,
    new.latest_message_id,
    null,
    null,
    null,
    new.id,
    null,
    null,
    'conversation_classified:' || new.id::text,
    'Conversation classified',
    coalesce(new.summary, new.recommended_action),
    jsonb_build_object(
      'priority', new.priority,
      'response_need', new.response_need,
      'topic_tags', new.topic_tags,
      'buyer_flags', new.buyer_flags,
      'risk_flags', new.risk_flags,
      'confidence', new.confidence,
      'classification_status', new.classification_status
    )
  );

  return new;
end;
$$;

create or replace function public.log_ebay_classification_override_activity()
returns trigger
language plpgsql
as $$
begin
  perform public.record_ebay_message_activity_event(
    'classification_changed',
    'recorded',
    new.created_by,
    new.created_by_email,
    new.conversation_id,
    null,
    null,
    null,
    null,
    new.classification_id,
    null,
    null,
    'classification_changed:' || new.id::text,
    'Classification changed',
    new.operator_notes,
    jsonb_build_object(
      'event_type', new.event_type,
      'previous_state', new.previous_state,
      'override_payload', new.override_payload,
      'new_state', new.new_state
    )
  );

  return new;
end;
$$;

create or replace function public.log_ebay_draft_activity()
returns trigger
language plpgsql
as $$
declare
  v_event_type text;
  v_actor uuid;
begin
  if tg_op = 'INSERT' then
    v_event_type := case when new.source_mode = 'improve' then 'draft_improved' else 'draft_generated' end;
    v_actor := new.created_by;

    perform public.record_ebay_message_activity_event(
      v_event_type,
      case when new.validation_status in ('invalid', 'error') then 'warning' else 'succeeded' end,
      v_actor,
      null,
      new.conversation_id,
      new.target_message_id,
      new.id,
      null,
      null,
      new.classification_id,
      null,
      null,
      v_event_type || ':' || new.id::text,
      case when v_event_type = 'draft_improved' then 'Draft improved' else 'Draft generated' end,
      null,
      jsonb_build_object(
        'source_mode', new.source_mode,
        'draft_status', new.draft_status,
        'draft_version', new.draft_version,
        'validation_status', new.validation_status,
        'confidence', new.confidence
      )
    );

    return new;
  end if;

  if new.draft_status = 'discarded' and old.draft_status is distinct from new.draft_status then
    perform public.record_ebay_message_activity_event(
      'draft_discarded',
      'recorded',
      new.updated_by,
      null,
      new.conversation_id,
      new.target_message_id,
      new.id,
      null,
      null,
      new.classification_id,
      null,
      null,
      'draft_discarded:' || new.id::text || ':' || coalesce(new.discarded_at::text, new.updated_at::text),
      'Draft discarded',
      new.operator_notes,
      jsonb_build_object('draft_version', new.draft_version)
    );
  elsif new.draft_status = 'saved'
    and (
      old.final_text is distinct from new.final_text
      or old.edited_text is distinct from new.edited_text
      or old.operator_notes is distinct from new.operator_notes
    )
  then
    perform public.record_ebay_message_activity_event(
      'draft_edited',
      'recorded',
      new.updated_by,
      null,
      new.conversation_id,
      new.target_message_id,
      new.id,
      null,
      null,
      new.classification_id,
      null,
      null,
      'draft_edited:' || new.id::text || ':' || new.updated_at::text,
      'Draft edited',
      new.operator_notes,
      jsonb_build_object('draft_version', new.draft_version)
    );
  end if;

  return new;
end;
$$;

create or replace function public.log_ebay_approval_activity()
returns trigger
language plpgsql
as $$
begin
  perform public.record_ebay_message_activity_event(
    case when new.approval_status = 'approved' then 'draft_approved' else 'approval_removed' end,
    'recorded',
    coalesce(new.approved_by, new.removed_by),
    coalesce(new.approved_by_email, new.removed_by_email),
    new.conversation_id,
    new.target_message_id,
    new.draft_id,
    new.id,
    null,
    null,
    null,
    null,
    new.approval_status || ':' || new.id::text,
    case when new.approval_status = 'approved' then 'Draft approved' else 'Approval removed' end,
    coalesce(new.approval_notes, new.removal_notes),
    jsonb_build_object(
      'approval_status', new.approval_status,
      'approved_at', new.approved_at,
      'removed_at', new.removed_at,
      'previous_approval_id', new.previous_approval_id,
      'idempotency_key', new.idempotency_key
    )
  );

  return new;
end;
$$;

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
      else 'send_attempt_created'
    end;
  elsif new.attempt_status is distinct from old.attempt_status then
    v_event_type := case
      when new.attempt_status = 'succeeded' then 'send_attempt_succeeded'
      when new.attempt_status = 'failed' then 'send_attempt_failed'
      else null
    end;
  end if;

  if v_event_type is not null then
    perform public.record_ebay_message_activity_event(
      v_event_type,
      case when new.attempt_status = 'failed' then 'failed' when new.attempt_status = 'succeeded' then 'succeeded' else 'pending' end,
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
        when v_event_type = 'send_attempt_succeeded' then 'Send attempt succeeded'
        when v_event_type = 'send_attempt_failed' then 'Send attempt failed'
        else 'Send attempt created'
      end,
      new.error_message,
      jsonb_build_object(
        'attempt_status', new.attempt_status,
        'provider', new.provider,
        'provider_message_id', new.provider_message_id,
        'provider_correlation_id', new.provider_correlation_id,
        'idempotency_key', new.idempotency_key,
        'attempt_sequence', new.attempt_sequence
      )
    );
  end if;

  return new;
end;
$$;

create or replace function public.log_ebay_saved_view_activity()
returns trigger
language plpgsql
as $$
declare
  v_event_type text;
  v_actor uuid;
begin
  if tg_op = 'INSERT' then
    v_event_type := 'smart_folder_created';
    v_actor := new.created_by;
  else
    v_event_type := 'smart_folder_updated';
    v_actor := new.updated_by;
  end if;

  perform public.record_ebay_message_activity_event(
    v_event_type,
    'recorded',
    v_actor,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    new.id,
    null,
    v_event_type || ':' || new.id::text || ':' || case when tg_op = 'INSERT' then new.created_at::text else new.updated_at::text end,
    case when v_event_type = 'smart_folder_created' then 'Smart folder created' else 'Smart folder updated' end,
    new.name,
    jsonb_build_object(
      'name', new.name,
      'system_key', new.system_key,
      'is_system_default', new.is_system_default,
      'is_active', new.is_active
    )
  );

  return new;
end;
$$;

drop trigger if exists trg_ebay_message_activity_events_immutable on public.ebay_message_activity_events;
create trigger trg_ebay_message_activity_events_immutable
before update or delete on public.ebay_message_activity_events
for each row execute function public.prevent_ebay_message_activity_event_mutation();

drop trigger if exists trg_ebay_message_approvals_immutable on public.ebay_message_approvals;
create trigger trg_ebay_message_approvals_immutable
before update or delete on public.ebay_message_approvals
for each row execute function public.prevent_ebay_message_approval_mutation();

drop trigger if exists trg_ebay_message_send_attempt_identity on public.ebay_message_send_attempts;
create trigger trg_ebay_message_send_attempt_identity
before update or delete on public.ebay_message_send_attempts
for each row execute function public.protect_ebay_message_send_attempt_identity();

drop trigger if exists trg_ebay_conversations_activity on public.ebay_conversations;
create trigger trg_ebay_conversations_activity
after insert or update on public.ebay_conversations
for each row execute function public.log_ebay_conversation_sync_activity();

drop trigger if exists trg_ebay_conversation_classifications_activity on public.ebay_conversation_classifications;
create trigger trg_ebay_conversation_classifications_activity
after insert on public.ebay_conversation_classifications
for each row execute function public.log_ebay_classification_activity();

drop trigger if exists trg_ebay_conversation_classification_overrides_activity on public.ebay_conversation_classification_overrides;
create trigger trg_ebay_conversation_classification_overrides_activity
after insert on public.ebay_conversation_classification_overrides
for each row execute function public.log_ebay_classification_override_activity();

drop trigger if exists trg_ebay_conversation_response_drafts_activity on public.ebay_conversation_response_drafts;
create trigger trg_ebay_conversation_response_drafts_activity
after insert or update on public.ebay_conversation_response_drafts
for each row execute function public.log_ebay_draft_activity();

drop trigger if exists trg_ebay_message_approvals_activity on public.ebay_message_approvals;
create trigger trg_ebay_message_approvals_activity
after insert on public.ebay_message_approvals
for each row execute function public.log_ebay_approval_activity();

drop trigger if exists trg_ebay_message_send_attempts_activity on public.ebay_message_send_attempts;
create trigger trg_ebay_message_send_attempts_activity
after insert or update on public.ebay_message_send_attempts
for each row execute function public.log_ebay_send_attempt_activity();

drop trigger if exists trg_ebay_conversation_saved_views_activity on public.ebay_conversation_saved_views;
create trigger trg_ebay_conversation_saved_views_activity
after insert or update on public.ebay_conversation_saved_views
for each row execute function public.log_ebay_saved_view_activity();

comment on table public.ebay_message_approvals
  is 'Append-only approval and approval-removal history for eBay conversation drafts. Approval does not send.';

comment on table public.ebay_message_send_attempts
  is 'Future controlled-send attempt ledger. Retry rows share a logical idempotency key; only one succeeded row per key is allowed.';

comment on table public.ebay_message_activity_events
  is 'Immutable eBay-native operational activity feed for the messaging dashboard.';
