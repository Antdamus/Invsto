-- Step 5F.6S.4 long-running workflow reconciliation.
-- Adds durable classification batch runs and first-class partial-success
-- dashboard statuses. This does not add send, live sync, read/unread sync,
-- return messaging, or provider mutation behavior.

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
      and pg_get_constraintdef(c.oid) like '%status%'
  loop
    execute format('alter table public.ebay_message_activity_events drop constraint %I', v_constraint);
  end loop;
end;
$$;

alter table public.ebay_message_activity_events
  add constraint ebay_message_activity_events_status_check
  check (status in (
    'recorded',
    'pending',
    'running',
    'succeeded',
    'partial_success',
    'failed',
    'warning',
    'blocked'
  ));

create table if not exists public.ebay_conversation_classification_runs (
  id uuid primary key default gen_random_uuid(),
  run_mode text not null
    check (run_mode in ('classify_unclassified_conversations', 'reclassify_recent_100')),
  status text not null default 'pending'
    check (status in ('pending', 'running', 'succeeded', 'partial_success', 'failed')),
  started_by uuid references auth.users(id) on delete set null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  requested_limit integer not null default 0 check (requested_limit >= 0),
  target_count integer not null default 0 check (target_count >= 0),
  processed_count integer not null default 0 check (processed_count >= 0),
  attempted_count integer not null default 0 check (attempted_count >= 0),
  classified_count integer not null default 0 check (classified_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  skipped_count integer not null default 0 check (skipped_count >= 0),
  remaining_unclassified integer check (remaining_unclassified is null or remaining_unclassified >= 0),
  unclassified_before integer check (unclassified_before is null or unclassified_before >= 0),
  force boolean not null default false,
  queue_source text,
  canonical_queue text,
  classification_version text,
  prompt_version text,
  model_name text,
  duration_ms integer not null default 0 check (duration_ms >= 0),
  conversation_ids uuid[] not null default '{}'::uuid[],
  succeeded_conversation_ids uuid[] not null default '{}'::uuid[],
  failed_conversation_ids uuid[] not null default '{}'::uuid[],
  skipped_conversation_ids uuid[] not null default '{}'::uuid[],
  failures jsonb not null default '[]'::jsonb,
  skipped_results jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ebay_conversation_classification_runs_completion_check
    check (
      (status in ('pending', 'running') and completed_at is null)
      or (status in ('succeeded', 'partial_success', 'failed') and completed_at is not null)
    )
);

create index if not exists ebay_conversation_classification_runs_started_idx
  on public.ebay_conversation_classification_runs(started_at desc);

create index if not exists ebay_conversation_classification_runs_status_started_idx
  on public.ebay_conversation_classification_runs(status, started_at desc);

alter table public.ebay_conversation_classification_runs enable row level security;

revoke all on table public.ebay_conversation_classification_runs from public, anon, authenticated;
grant select on table public.ebay_conversation_classification_runs to authenticated;
grant select, insert, update, delete on table public.ebay_conversation_classification_runs to service_role;

drop policy if exists "ebay_conversation_classification_runs_staff_select" on public.ebay_conversation_classification_runs;
create policy "ebay_conversation_classification_runs_staff_select"
on public.ebay_conversation_classification_runs
for select
to authenticated
using (public.can_manage_inventory());

drop trigger if exists trg_ebay_conversation_classification_runs_updated_at on public.ebay_conversation_classification_runs;
create trigger trg_ebay_conversation_classification_runs_updated_at
before update on public.ebay_conversation_classification_runs
for each row execute function public.touch_ebay_messaging_updated_at();

create or replace function public.ebay_classification_run_payload(_run public.ebay_conversation_classification_runs)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'run_id', _run.id,
    'status', _run.status,
    'run_mode', _run.run_mode,
    'force', _run.force,
    'started_at', _run.started_at,
    'completed_at', _run.completed_at,
    'requested_limit', _run.requested_limit,
    'requested', _run.requested_limit,
    'target_count', _run.target_count,
    'processed_count', _run.processed_count,
    'processed', _run.processed_count,
    'attempted_count', _run.attempted_count,
    'attempted', _run.attempted_count,
    'classified_count', _run.classified_count,
    'actually_classified', _run.classified_count,
    'succeeded_count', _run.classified_count,
    'succeeded', _run.classified_count,
    'failed_count', _run.failed_count,
    'failed', _run.failed_count,
    'skipped_count', _run.skipped_count,
    'skipped', _run.skipped_count,
    'remaining_unclassified', _run.remaining_unclassified,
    'unclassified_before', _run.unclassified_before,
    'unclassified_after', _run.remaining_unclassified,
    'classification_version', _run.classification_version,
    'prompt_version', _run.prompt_version,
    'model_name', _run.model_name,
    'duration_ms', _run.duration_ms,
    'conversation_ids', _run.conversation_ids,
    'succeeded_conversation_ids', _run.succeeded_conversation_ids,
    'failed_conversation_ids', _run.failed_conversation_ids,
    'skipped_conversation_ids', _run.skipped_conversation_ids,
    'failures', _run.failures,
    'skipped_results', _run.skipped_results,
    'queue_source', _run.queue_source,
    'canonical_queue', _run.canonical_queue,
    'metadata', _run.metadata,
    'safety', jsonb_build_object(
      'ebay_mutation_performed', false,
      'automatic_responses_sent', 0,
      'classification_triggered', _run.attempted_count > 0
    )
  );
$$;

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
      when new.status = 'failed' then 'Classification Batch Failed'
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

drop trigger if exists trg_ebay_classification_run_activity on public.ebay_conversation_classification_runs;
create trigger trg_ebay_classification_run_activity
after insert or update on public.ebay_conversation_classification_runs
for each row execute function public.log_ebay_classification_run_activity();

comment on table public.ebay_conversation_classification_runs
  is 'Durable operator-visible lifecycle and counters for bounded eBay conversation classification batches.';
