-- Step 5F.6P.2B count, folder, and read-state stabilization.
-- Restores the unclassified canonical mailbox branch that was lost in the
-- participant-identity RPC replacement, keeps provider read-state and
-- participant identity behavior, and cleans up saved system views.

do $$
declare
  v_function_sql text;
begin
  select pg_get_functiondef(
    'public.get_ebay_canonical_mailbox_v2(integer, integer, text, text[], jsonb, jsonb)'::regprocedure
  )
  into v_function_sql;

  if v_function_sql is null then
    raise exception 'get_ebay_canonical_mailbox_v2_not_found';
  end if;

  if position('when ''unclassified'' then b.classification_id is null' in v_function_sql) = 0 then
    if position('when ''unread'' then b.unread_count > 0' in v_function_sql) = 0 then
      raise exception 'mailbox_rpc_unread_branch_not_found';
    end if;

    v_function_sql := replace(
      v_function_sql,
      'when ''unread'' then b.unread_count > 0',
      'when ''unread'' then b.unread_count > 0
        when ''unclassified'' then b.classification_id is null'
    );
  end if;

  if position('''unclassified'', count(*) filter (where classification_id is null)' in v_function_sql) = 0 then
    if position('''unread'', count(*) filter (where unread_count > 0),' in v_function_sql) = 0 then
      raise exception 'mailbox_rpc_unread_count_not_found';
    end if;

    v_function_sql := replace(
      v_function_sql,
      '''unread'', count(*) filter (where unread_count > 0),',
      '''unread'', count(*) filter (where unread_count > 0),
      ''unclassified'', count(*) filter (where classification_id is null),'
    );
  end if;

  if position('if not public.can_manage_inventory() then' in v_function_sql) > 0 then
    v_function_sql := replace(
      v_function_sql,
      'if not public.can_manage_inventory() then',
      'if auth.role() <> ''service_role'' and not public.can_manage_inventory() then'
    );
  end if;

  v_function_sql := replace(
    v_function_sql,
    '''rpc_version'', ''v2_provider_read_state''',
    '''rpc_version'', ''v2_unclassified_participant_read_state'''
  );

  execute v_function_sql;
end;
$$;

create or replace function public.count_ebay_unclassified_conversations()
returns integer
language plpgsql
stable
set search_path = public
as $$
declare
  v_count integer;
begin
  if auth.role() <> 'service_role' and not public.can_manage_inventory() then
    raise exception 'not_authorized';
  end if;

  select count(*)::integer
  into v_count
  from public.ebay_conversations c
  where not exists (
    select 1
    from public.ebay_conversation_classifications cc
    where cc.conversation_id = c.id
      and cc.is_current = true
  );

  return coalesce(v_count, 0);
end;
$$;

create or replace function public.get_ebay_unclassified_conversation_queue(
  _limit integer default 100
)
returns table (
  id uuid,
  ebay_conversation_id text,
  latest_message_id text,
  latest_message_created_at timestamptz,
  last_message_created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
set search_path = public
as $$
declare
  v_limit integer := least(greatest(coalesce(_limit, 100), 1), 100);
begin
  if auth.role() <> 'service_role' and not public.can_manage_inventory() then
    raise exception 'not_authorized';
  end if;

  return query
  select
    c.id,
    c.ebay_conversation_id,
    c.latest_message_id,
    c.latest_message_created_at,
    c.last_message_created_at,
    c.updated_at
  from public.ebay_conversations c
  where not exists (
    select 1
    from public.ebay_conversation_classifications cc
    where cc.conversation_id = c.id
      and cc.is_current = true
  )
  order by c.latest_message_created_at desc nulls last, c.updated_at desc nulls last, c.id desc
  limit v_limit;
end;
$$;

revoke all on function public.count_ebay_unclassified_conversations() from public, anon;
grant execute on function public.count_ebay_unclassified_conversations() to authenticated;
grant execute on function public.count_ebay_unclassified_conversations() to service_role;

revoke all on function public.get_ebay_unclassified_conversation_queue(integer) from public, anon;
grant execute on function public.get_ebay_unclassified_conversation_queue(integer) to authenticated;
grant execute on function public.get_ebay_unclassified_conversation_queue(integer) to service_role;

comment on function public.count_ebay_unclassified_conversations()
  is 'Canonical anti-join count of eBay conversations with no current classification. Used as a guardrail for Classify New.';

comment on function public.get_ebay_unclassified_conversation_queue(integer)
  is 'Canonical anti-join queue of eBay conversations with no current classification, ordered by latest conversation activity.';

update public.ebay_conversation_saved_views
set
  filter_payload = jsonb_set(
    coalesce(filter_payload, '{}'::jsonb),
    '{system_filter}',
    '"needs_reply_today"'::jsonb,
    true
  ),
  deleted_at = null,
  is_active = true,
  updated_at = now()
where is_system_default = true
  and system_key = 'needs_reply_today';

update public.ebay_conversation_saved_views
set
  deleted_at = null,
  is_active = true,
  updated_at = now()
where is_system_default = true
  and system_key in ('review_queue', 'has_return');

