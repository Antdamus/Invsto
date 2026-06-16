-- Step 5F.6S.4A reclassify terminalization fix.
-- Keeps durable classification runs from staying open after work stops.

create or replace function public.log_ebay_classification_run_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payload jsonb;
  v_mode_label text;
  v_event_status text;
  v_title text;
  v_detail text;
  v_suffix text;
begin
  v_payload := public.ebay_classification_run_payload(new);
  v_mode_label := case
    when new.run_mode = 'reclassify_recent_100' then 'Reclassify Recent 100'
    else 'Classify Unclassified'
  end;

  if tg_op = 'INSERT' then
    perform public.record_ebay_message_activity_event(
      'conversation_classified',
      new.status,
      new.started_by,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      'conversation_classification_run:' || new.id::text || ':started',
      'Classification Batch Started',
      v_mode_label || ' started. Requested bounded limit: ' || new.requested_limit::text || '.',
      jsonb_build_object(
        'classification_run', v_payload,
        'lifecycle_status', 'started'
      ) || v_payload
    );
    return new;
  end if;

  if new.status in ('succeeded', 'partial_success', 'failed')
    and old.status is distinct from new.status
  then
    v_event_status := new.status;
    v_title := case
      when new.status = 'partial_success' then 'Classification Run Partial Success'
      when new.status = 'failed' then 'Classification Run Failed'
      else 'Classification Run Completed'
    end;
    v_suffix := case
      when new.status = 'partial_success' then 'completed with partial success'
      when new.status = 'failed' then 'failed'
      else 'completed successfully'
    end;
    v_detail := v_mode_label || ' ' || v_suffix ||
      '. Candidates examined: ' || new.processed_count::text ||
      '; actually classified: ' || new.classified_count::text ||
      '; skipped: ' || new.skipped_count::text ||
      '; failed: ' || new.failed_count::text ||
      '; remaining unclassified: ' || coalesce(new.remaining_unclassified::text, 'unknown') ||
      '; duration: ' || new.duration_ms::text || ' ms.';

    perform public.record_ebay_message_activity_event(
      'conversation_classified',
      v_event_status,
      new.started_by,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      'conversation_classification_run:' || new.id::text || ':completed',
      v_title,
      v_detail,
      jsonb_build_object(
        'classification_run', v_payload,
        'lifecycle_status', 'completed'
      ) || v_payload
    );
  end if;

  return new;
end;
$$;

create or replace function public.reconcile_ebay_conversation_classification_runs(
  _stale_after_seconds integer default 480
)
returns table (
  run_id uuid,
  previous_status text,
  terminal_status text,
  processed_count integer,
  classified_count integer,
  failed_count integer,
  skipped_count integer,
  reconciled_reason text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text := coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), session_user);
  v_stale_after interval := make_interval(secs => greatest(coalesce(_stale_after_seconds, 480), 60));
  v_now timestamptz := now();
  v_run public.ebay_conversation_classification_runs%rowtype;
  v_total_conversations integer := 0;
  v_current_classifications integer := 0;
  v_remaining_unclassified integer := null;
  v_classified_from_rows integer := 0;
  v_classified integer := 0;
  v_failed integer := 0;
  v_skipped integer := 0;
  v_processed integer := 0;
  v_attempted integer := 0;
  v_duration_ms integer := 0;
  v_terminal_status text;
  v_reason text;
  v_classified_ids uuid[] := '{}'::uuid[];
  v_succeeded_ids uuid[] := '{}'::uuid[];
begin
  if v_role not in ('service_role', 'postgres', 'supabase_admin') and not public.can_manage_inventory() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select count(*)::integer
    into v_total_conversations
  from public.ebay_conversations;

  select count(distinct conversation_id)::integer
    into v_current_classifications
  from public.ebay_conversation_classifications
  where is_current = true;

  v_remaining_unclassified := greatest(coalesce(v_total_conversations, 0) - coalesce(v_current_classifications, 0), 0);

  for v_run in
    select *
    from public.ebay_conversation_classification_runs
    where status in ('pending', 'running')
    order by started_at asc
  loop
    select
      count(*)::integer,
      coalesce(array_agg(conversation_id order by created_at desc), '{}'::uuid[])
      into v_classified_from_rows, v_classified_ids
    from public.ebay_conversation_classifications
    where validation_metadata->>'classification_run_id' = v_run.id::text;

    v_classified := greatest(coalesce(v_run.classified_count, 0), coalesce(v_classified_from_rows, 0));
    v_failed := coalesce(v_run.failed_count, 0);
    v_skipped := coalesce(v_run.skipped_count, 0);
    v_processed := greatest(
      coalesce(v_run.processed_count, 0),
      v_classified + v_failed + v_skipped
    );

    if coalesce(v_run.target_count, 0) > 0 and v_processed >= v_run.target_count then
      v_reason := 'processed_target_count';
      v_processed := greatest(v_processed, v_run.target_count);
    elsif coalesce(v_run.updated_at, v_run.started_at) < v_now - v_stale_after then
      v_reason := 'stale_open_run_timeout';
    else
      continue;
    end if;

    if v_failed > 0 then
      v_terminal_status := case when v_classified > 0 or v_skipped > 0 then 'partial_success' else 'failed' end;
    elsif coalesce(v_run.target_count, 0) > 0 and v_processed < v_run.target_count then
      v_terminal_status := case when v_classified > 0 or v_skipped > 0 then 'partial_success' else 'failed' end;
    else
      v_terminal_status := 'succeeded';
    end if;

    v_attempted := greatest(coalesce(v_run.attempted_count, 0), greatest(v_processed - v_skipped, 0));
    v_duration_ms := greatest(
      coalesce(v_run.duration_ms, 0),
      floor(extract(epoch from (v_now - v_run.started_at)) * 1000)::integer
    );

    select coalesce(array_agg(distinct item), '{}'::uuid[])
      into v_succeeded_ids
    from unnest(coalesce(v_run.succeeded_conversation_ids, '{}'::uuid[]) || coalesce(v_classified_ids, '{}'::uuid[])) as merged(item);

    update public.ebay_conversation_classification_runs
    set
      status = v_terminal_status,
      completed_at = v_now,
      processed_count = v_processed,
      attempted_count = v_attempted,
      classified_count = v_classified,
      failed_count = v_failed,
      skipped_count = v_skipped,
      remaining_unclassified = coalesce(v_remaining_unclassified, v_run.remaining_unclassified),
      duration_ms = v_duration_ms,
      succeeded_conversation_ids = v_succeeded_ids,
      metadata = coalesce(v_run.metadata, '{}'::jsonb) || jsonb_build_object(
        'reconciled_at', v_now,
        'reconciled_reason', v_reason,
        'terminalized_by', 'reconcile_ebay_conversation_classification_runs'
      )
    where id = v_run.id
      and status in ('pending', 'running');

    if found then
      run_id := v_run.id;
      previous_status := v_run.status;
      terminal_status := v_terminal_status;
      processed_count := v_processed;
      classified_count := v_classified;
      failed_count := v_failed;
      skipped_count := v_skipped;
      reconciled_reason := v_reason;
      return next;
    end if;
  end loop;
end;
$$;

revoke all on function public.reconcile_ebay_conversation_classification_runs(integer) from public, anon;
grant execute on function public.reconcile_ebay_conversation_classification_runs(integer) to authenticated, service_role;
