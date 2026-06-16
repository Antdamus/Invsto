-- Step 5F.6S.4E reclassify runtime budget and truthful maintenance scope.
-- Keeps legacy reclassify_recent_100 history readable while making the active
-- operator maintenance action a bounded reclassify_recent_20 run.

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
      and t.relname = 'ebay_conversation_classification_runs'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) like '%run_mode%'
  loop
    execute format('alter table public.ebay_conversation_classification_runs drop constraint %I', v_constraint);
  end loop;
end;
$$;

alter table public.ebay_conversation_classification_runs
  add constraint ebay_conversation_classification_runs_run_mode_check
  check (run_mode in (
    'classify_unclassified_conversations',
    'reclassify_recent_100',
    'reclassify_recent_20'
  ));

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
    when new.run_mode = 'reclassify_recent_20' then 'Reclassify Recent 20'
    when new.run_mode = 'reclassify_recent_100' then 'Reclassify Recent 100 (legacy)'
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
      '; duration: ' || new.duration_ms::text || ' ms' ||
      case
        when coalesce((new.metadata ->> 'runtime_budget_exhausted')::boolean, false)
          then '; runtime budget reached before the full bounded scope completed.'
        else '.'
      end;

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
