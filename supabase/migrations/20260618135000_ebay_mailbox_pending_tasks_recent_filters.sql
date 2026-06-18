-- Add full-mailbox filters for Email Triage pending linked tasks and recent chats.
-- New migration on purpose: Supabase will not replay edited prior migrations.

do $migration$
declare
  v_signature regprocedure := 'public.get_ebay_canonical_mailbox_v2(integer, integer, text, text[], jsonb, jsonb)'::regprocedure;
  v_sql text;
  v_next text;
begin
  v_sql := pg_get_functiondef(v_signature);

  if position('pending_task_count' in v_sql) = 0 then
    v_next := v_sql;

    v_next := replace(
      v_next,
      '      coalesce(link_stats.link_rows, ''[]''::jsonb) as link_rows,',
      '      coalesce(link_stats.link_rows, ''[]''::jsonb) as link_rows,
      coalesce(task_stats.task_count, 0) as task_count,
      coalesce(task_stats.pending_task_count, 0) as pending_task_count,'
    );

    v_next := replace(
      v_next,
      $needle$
    ) link_stats on true
    left join lateral (
      with message_rows as (
$needle$,
      $replacement$
    ) link_stats on true
    left join lateral (
      select
        count(*)::integer as task_count,
        count(*) filter (where t.status not in ('resolved', 'cancelled'))::integer as pending_task_count
      from public.team_tasks t
      where t.metadata ->> 'source' = 'ebay_conversation_message'
        and t.metadata ->> 'conversation_id' = c.id::text
        and t.metadata ->> 'history_removed_at' is null
    ) task_stats on true
    left join lateral (
      with message_rows as (
$replacement$
    );

    v_next := replace(
      v_next,
      $needle$
        when 'has_media' then b.has_media
        when 'needs_context_review' then b.link_count = 0 or b.suggested_link_count > 0
        else true
$needle$,
      $replacement$
        when 'has_media' then b.has_media
        when 'needs_context_review' then b.link_count = 0 or b.suggested_link_count > 0
        when 'pending_tasks' then b.pending_task_count > 0
        when 'last_24_hours' then coalesce(b.latest_message_created_at, b.last_message_created_at, b.updated_at, b.created_at) >= now() - interval '24 hours'
        else true
$replacement$
    );

    v_next := replace(
      v_next,
      $needle$
      'has_return', count(*) filter (where has_return_link),
      'has_media', count(*) filter (where has_media),
      'needs_context_review', count(*) filter (where link_count = 0 or suggested_link_count > 0)
$needle$,
      $replacement$
      'has_return', count(*) filter (where has_return_link),
      'has_media', count(*) filter (where has_media),
      'needs_context_review', count(*) filter (where link_count = 0 or suggested_link_count > 0),
      'pending_tasks', count(*) filter (where pending_task_count > 0),
      'last_24_hours', count(*) filter (where coalesce(latest_message_created_at, last_message_created_at, updated_at, created_at) >= now() - interval '24 hours')
$replacement$
    );

    v_next := replace(
      v_next,
      $needle$
            'needs_context_review', p.link_count = 0 or p.suggested_link_count > 0,
            'participant_usernames', p.participant_usernames,
$needle$,
      $replacement$
            'needs_context_review', p.link_count = 0 or p.suggested_link_count > 0,
            'task_count', p.task_count,
            'pending_task_count', p.pending_task_count,
            'participant_usernames', p.participant_usernames,
$replacement$
    );

    v_next := replace(
      v_next,
      '''rpc_version'', ''v2_provider_read_state'',',
      '''rpc_version'', ''v2_pending_tasks_recent_filters'','
    );

    if v_next = v_sql
      or position('coalesce(task_stats.pending_task_count, 0) as pending_task_count' in v_next) = 0
      or position(') task_stats on true' in v_next) = 0
      or position('when ''pending_tasks'' then b.pending_task_count > 0' in v_next) = 0
      or position('''pending_tasks'', count(*) filter (where pending_task_count > 0)' in v_next) = 0
      or position('''pending_task_count'', p.pending_task_count' in v_next) = 0 then
      raise exception 'pending_tasks_recent_filter_rpc_patch_not_applied';
    end if;

    execute v_next;
  end if;
end;
$migration$;

insert into public.ebay_conversation_saved_views
  (name, description, filter_payload, system_key, is_system_default, sort_order)
values
  (
    'Pending tasks',
    'Conversations with open customer-service tasks linked from eBay messages.',
    '{"version":1,"system_filter":"pending_tasks","search_query":"","classification_filters":{"topics":[],"buyerFlags":[],"riskFlags":[],"priorities":[],"responseNeeds":[]}}'::jsonb,
    'pending_tasks',
    true,
    95
  ),
  (
    'Last 24 hours',
    'Conversations with message activity in the last 24 hours.',
    '{"version":1,"system_filter":"last_24_hours","search_query":"","classification_filters":{"topics":[],"buyerFlags":[],"riskFlags":[],"priorities":[],"responseNeeds":[]}}'::jsonb,
    'last_24_hours',
    true,
    96
  )
on conflict (system_key) where system_key is not null do update
set
  name = excluded.name,
  description = excluded.description,
  filter_payload = excluded.filter_payload,
  is_system_default = true,
  sort_order = excluded.sort_order,
  is_active = true,
  deleted_at = null,
  updated_at = now();

comment on function public.get_ebay_canonical_mailbox_v2(integer, integer, text, text[], jsonb, jsonb)
  is 'Versioned canonical eBay mailbox read model with pending-task and last-24-hours filters for Email Triage.';
