-- Persist each triage user's personal eBay read state and mark successfully
-- answered conversations as waiting on the buyer until a newer inbound arrives.

create table if not exists public.ebay_conversation_user_read_states (
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.ebay_conversations(id) on delete cascade,
  read_state text not null default 'read'
    check (read_state in ('read', 'unread')),
  latest_message_id text,
  latest_message_created_at timestamptz,
  read_at timestamptz,
  unread_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, conversation_id)
);

alter table public.ebay_conversation_user_read_states enable row level security;

revoke all on table public.ebay_conversation_user_read_states from public, anon, authenticated;
grant select, insert, update, delete on table public.ebay_conversation_user_read_states to authenticated;
grant select, insert, update, delete on table public.ebay_conversation_user_read_states to service_role;

create index if not exists ebay_conversation_user_read_states_conversation_idx
  on public.ebay_conversation_user_read_states(conversation_id, updated_at desc);

create index if not exists ebay_conversation_user_read_states_user_state_idx
  on public.ebay_conversation_user_read_states(user_id, read_state, updated_at desc);

drop policy if exists "ebay_conversation_user_read_states_owner_select" on public.ebay_conversation_user_read_states;
create policy "ebay_conversation_user_read_states_owner_select"
on public.ebay_conversation_user_read_states
for select
to authenticated
using (
  user_id = auth.uid()
  and public.can_access_email_triage()
);

drop policy if exists "ebay_conversation_user_read_states_owner_insert" on public.ebay_conversation_user_read_states;
create policy "ebay_conversation_user_read_states_owner_insert"
on public.ebay_conversation_user_read_states
for insert
to authenticated
with check (
  user_id = auth.uid()
  and public.can_access_email_triage()
);

drop policy if exists "ebay_conversation_user_read_states_owner_update" on public.ebay_conversation_user_read_states;
create policy "ebay_conversation_user_read_states_owner_update"
on public.ebay_conversation_user_read_states
for update
to authenticated
using (
  user_id = auth.uid()
  and public.can_access_email_triage()
)
with check (
  user_id = auth.uid()
  and public.can_access_email_triage()
);

drop policy if exists "ebay_conversation_user_read_states_owner_delete" on public.ebay_conversation_user_read_states;
create policy "ebay_conversation_user_read_states_owner_delete"
on public.ebay_conversation_user_read_states
for delete
to authenticated
using (
  user_id = auth.uid()
  and public.can_access_email_triage()
);

create or replace function public.upsert_ebay_conversation_user_read_state(
  _conversation_id uuid,
  _read_state text default 'read',
  _latest_message_id text default null,
  _latest_message_created_at timestamptz default null
)
returns table (
  conversation_id uuid,
  read_state text,
  latest_message_id text,
  latest_message_created_at timestamptz,
  read_at timestamptz,
  unread_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_read_state text := case when lower(coalesce(_read_state, 'read')) = 'unread' then 'unread' else 'read' end;
  v_latest_message_id text := nullif(btrim(coalesce(_latest_message_id, '')), '');
  v_latest_message_created_at timestamptz := _latest_message_created_at;
  v_now timestamptz := now();
begin
  if v_user_id is null then
    raise exception 'Authentication is required to save eBay read state'
      using errcode = '28000';
  end if;

  if _conversation_id is null then
    raise exception 'conversation_id_required'
      using errcode = '22023';
  end if;

  select
    coalesce(v_latest_message_id, c.latest_message_id),
    coalesce(v_latest_message_created_at, c.latest_message_created_at, c.last_message_created_at, c.updated_at)
  into v_latest_message_id, v_latest_message_created_at
  from public.ebay_conversations c
  where c.id = _conversation_id;

  if not found then
    raise exception 'eBay conversation not found'
      using errcode = 'P0002';
  end if;

  return query
  with upserted as (
    insert into public.ebay_conversation_user_read_states (
      user_id,
      conversation_id,
      read_state,
      latest_message_id,
      latest_message_created_at,
      read_at,
      unread_at,
      updated_at
    )
    values (
      v_user_id,
      _conversation_id,
      v_read_state,
      v_latest_message_id,
      v_latest_message_created_at,
      case when v_read_state = 'read' then v_now else null end,
      case when v_read_state = 'unread' then v_now else null end,
      v_now
    )
    on conflict (user_id, conversation_id) do update
    set
      read_state = excluded.read_state,
      latest_message_id = excluded.latest_message_id,
      latest_message_created_at = excluded.latest_message_created_at,
      read_at = case
        when excluded.read_state = 'read' then v_now
        else public.ebay_conversation_user_read_states.read_at
      end,
      unread_at = case
        when excluded.read_state = 'unread' then v_now
        else public.ebay_conversation_user_read_states.unread_at
      end,
      updated_at = v_now
    returning *
  )
  select
    upserted.conversation_id,
    upserted.read_state,
    upserted.latest_message_id,
    upserted.latest_message_created_at,
    upserted.read_at,
    upserted.unread_at,
    upserted.updated_at
  from upserted;
end;
$$;

grant execute on function public.upsert_ebay_conversation_user_read_state(uuid, text, text, timestamptz) to authenticated;

create or replace function public.list_ebay_conversation_user_read_states(_conversation_ids uuid[])
returns table (
  conversation_id uuid,
  read_state text,
  latest_message_id text,
  latest_message_created_at timestamptz,
  read_at timestamptz,
  unread_at timestamptz,
  updated_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    states.conversation_id,
    states.read_state,
    states.latest_message_id,
    states.latest_message_created_at,
    states.read_at,
    states.unread_at,
    states.updated_at
  from public.ebay_conversation_user_read_states states
  where states.user_id = auth.uid()
    and public.can_access_email_triage()
    and (
      _conversation_ids is null
      or states.conversation_id = any(_conversation_ids)
    )
  order by states.updated_at desc;
$$;

grant execute on function public.list_ebay_conversation_user_read_states(uuid[]) to authenticated;

create or replace function public.mark_ebay_conversation_waiting_on_buyer_after_send(
  _conversation_id uuid,
  _send_attempt_id uuid default null,
  _actor_user_id uuid default null,
  _actor_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_latest public.ebay_conversation_messages%rowtype;
  v_current public.ebay_conversation_classifications%rowtype;
  v_updated public.ebay_conversation_classifications%rowtype;
  v_now timestamptz := now();
  v_previous_state jsonb := '{}'::jsonb;
  v_new_override jsonb := '{}'::jsonb;
  v_new_state jsonb := '{}'::jsonb;
begin
  if _conversation_id is null then
    return jsonb_build_object('ok', false, 'updated', false, 'reason', 'conversation_id_required');
  end if;

  if _send_attempt_id is not null and not exists (
    select 1
    from public.ebay_message_send_attempts attempts
    where attempts.id = _send_attempt_id
      and attempts.conversation_id = _conversation_id
      and attempts.attempt_status = 'succeeded'
  ) then
    return jsonb_build_object('ok', false, 'updated', false, 'reason', 'send_attempt_not_succeeded');
  end if;

  select messages.*
  into v_latest
  from public.ebay_conversation_messages messages
  where messages.conversation_id = _conversation_id
  order by
    coalesce(messages.created_at_ebay, messages.created_at) desc,
    messages.created_at desc,
    messages.id desc
  limit 1;

  if v_latest.id is null then
    return jsonb_build_object('ok', false, 'updated', false, 'reason', 'latest_message_not_found');
  end if;

  if lower(coalesce(v_latest.direction, '')) <> 'outbound' then
    return jsonb_build_object(
      'ok', true,
      'updated', false,
      'reason', 'latest_message_not_outbound',
      'latest_message_id', v_latest.id,
      'latest_ebay_message_id', v_latest.ebay_message_id
    );
  end if;

  select classifications.*
  into v_current
  from public.ebay_conversation_classifications classifications
  where classifications.conversation_id = _conversation_id
    and classifications.is_current = true
  order by classifications.created_at desc
  limit 1;

  if v_current.id is null then
    return jsonb_build_object('ok', true, 'updated', false, 'reason', 'classification_not_found');
  end if;

  v_previous_state := jsonb_build_object(
    'response_need', coalesce(nullif(v_current.operator_override_payload ->> 'response_need', ''), v_current.response_need),
    'latest_message_id', v_current.latest_message_id,
    'latest_ebay_message_id', v_current.latest_ebay_message_id,
    'operator_override_payload', coalesce(v_current.operator_override_payload, '{}'::jsonb)
  );

  v_new_override := coalesce(v_current.operator_override_payload, '{}'::jsonb)
    || jsonb_build_object(
      'response_need', 'waiting_on_buyer',
      'auto_response_status', 'responded_waiting_on_buyer',
      'auto_response_status_at', v_now,
      'auto_response_source', 'ebay_conversation_draft_send',
      'latest_outbound_message_id', v_latest.id,
      'latest_outbound_ebay_message_id', v_latest.ebay_message_id,
      'send_attempt_id', _send_attempt_id
    );

  update public.ebay_conversation_classifications
  set
    latest_message_id = v_latest.id,
    latest_ebay_message_id = v_latest.ebay_message_id,
    operator_override_payload = v_new_override,
    reviewed_by = coalesce(_actor_user_id, reviewed_by),
    reviewed_at = v_now,
    updated_at = v_now
  where id = v_current.id
  returning * into v_updated;

  v_new_state := jsonb_build_object(
    'response_need', 'waiting_on_buyer',
    'latest_message_id', v_updated.latest_message_id,
    'latest_ebay_message_id', v_updated.latest_ebay_message_id,
    'operator_override_payload', v_updated.operator_override_payload
  );

  insert into public.ebay_conversation_classification_overrides (
    classification_id,
    conversation_id,
    event_type,
    previous_state,
    override_payload,
    new_state,
    operator_notes,
    created_by,
    created_by_email
  )
  values (
    v_current.id,
    _conversation_id,
    'review_saved',
    v_previous_state,
    v_new_override,
    v_new_state,
    'Automatically marked waiting_on_buyer after a successful eBay reply.',
    _actor_user_id,
    nullif(btrim(coalesce(_actor_email, '')), '')
  );

  return jsonb_build_object(
    'ok', true,
    'updated', true,
    'conversation_id', _conversation_id,
    'classification_id', v_current.id,
    'response_need', 'waiting_on_buyer',
    'latest_message_id', v_latest.id,
    'latest_ebay_message_id', v_latest.ebay_message_id
  );
end;
$$;

revoke all on function public.mark_ebay_conversation_waiting_on_buyer_after_send(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.mark_ebay_conversation_waiting_on_buyer_after_send(uuid, uuid, uuid, text) to service_role;
