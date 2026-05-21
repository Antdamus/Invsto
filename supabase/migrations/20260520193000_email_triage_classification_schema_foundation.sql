-- Step 4B.2 classification schema and classify job foundation.
-- Additive only: strengthens email_message_classifications for replayable,
-- auditable AI classification without creating a classifier executor.

alter table public.email_message_classifications
  add column if not exists urgency text,
  add column if not exists response_needed boolean,
  add column if not exists recommended_action text,
  add column if not exists detected_entities jsonb not null default '{}'::jsonb,
  add column if not exists safety_flags text[] not null default '{}',
  add column if not exists summary text,
  add column if not exists model_name text,
  add column if not exists model_version text,
  add column if not exists prompt_version text,
  add column if not exists prompt_hash text,
  add column if not exists input_hash text,
  add column if not exists raw_safe_output jsonb,
  add column if not exists validation_status text,
  add column if not exists validation_errors jsonb not null default '[]'::jsonb,
  add column if not exists classification_run_id uuid,
  add column if not exists processing_job_id uuid references public.email_processing_jobs(id) on delete set null,
  add column if not exists input_version text,
  add column if not exists classified_at timestamptz,
  add column if not exists is_current boolean not null default true,
  add column if not exists superseded_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.email_message_classifications'::regclass
      and conname = 'email_message_classifications_urgency_check'
  ) then
    alter table public.email_message_classifications
      add constraint email_message_classifications_urgency_check
      check (urgency is null or urgency in ('none', 'later', 'soon', 'today', 'immediate'))
      not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.email_message_classifications'::regclass
      and conname = 'email_message_classifications_recommended_action_check'
  ) then
    alter table public.email_message_classifications
      add constraint email_message_classifications_recommended_action_check
      check (
        recommended_action is null or recommended_action in (
          'no_action',
          'archive_or_ignore',
          'review_only',
          'review_and_reply',
          'check_order_status',
          'check_shipping_status',
          'upload_or_verify_tracking',
          'prepare_return_response',
          'prepare_refund_review',
          'prepare_cancellation_review',
          'inspect_listing_or_inventory',
          'escalate_to_admin',
          'security_review'
        )
      )
      not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.email_message_classifications'::regclass
      and conname = 'email_message_classifications_validation_status_check'
  ) then
    alter table public.email_message_classifications
      add constraint email_message_classifications_validation_status_check
      check (validation_status is null or validation_status in ('valid', 'invalid', 'partial', 'skipped', 'error'))
      not valid;
  end if;
end $$;

do $$
declare
  existing_constraint record;
begin
  for existing_constraint in
    select conname, pg_get_constraintdef(oid) as definition
    from pg_constraint
    where conrelid = 'public.email_processing_jobs'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%job_type%'
  loop
    if existing_constraint.definition not ilike '%classify%' then
      execute format('alter table public.email_processing_jobs drop constraint %I', existing_constraint.conname);
    end if;
  end loop;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.email_processing_jobs'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%job_type%'
      and pg_get_constraintdef(oid) ilike '%classify%'
  ) then
    alter table public.email_processing_jobs
      add constraint email_processing_jobs_job_type_check
      check (job_type in ('normalize', 'match_order', 'classify', 'draft_response', 'embed'))
      not valid;
  end if;
end $$;

create index if not exists email_message_classifications_message_created_desc_idx
  on public.email_message_classifications(message_id, created_at desc);

create index if not exists email_message_classifications_category_urgency_priority_idx
  on public.email_message_classifications(category, urgency, priority);

create index if not exists email_message_classifications_review_created_desc_idx
  on public.email_message_classifications(requires_human_review, created_at desc);

create index if not exists email_message_classifications_response_needed_created_desc_idx
  on public.email_message_classifications(response_needed, created_at desc);

create index if not exists email_message_classifications_current_created_desc_idx
  on public.email_message_classifications(is_current, created_at desc);

create index if not exists email_message_classifications_processing_job_idx
  on public.email_message_classifications(processing_job_id)
  where processing_job_id is not null;

create index if not exists email_message_classifications_input_hash_idx
  on public.email_message_classifications(input_hash)
  where input_hash is not null;

create index if not exists email_message_classifications_classifier_prompt_idx
  on public.email_message_classifications(classifier_name, classifier_version, prompt_version);

do $$
begin
  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'email_message_classifications_input_dedupe_uidx'
      and c.relkind = 'i'
  ) then
    if exists (
      select 1
      from public.email_message_classifications
      where input_hash is not null
      group by message_id, source, classifier_name, classifier_version, input_hash
      having count(*) > 1
    ) then
      raise notice 'Skipping email_message_classifications_input_dedupe_uidx because existing duplicate classification inputs were found.';
    else
      create unique index email_message_classifications_input_dedupe_uidx
        on public.email_message_classifications(message_id, source, classifier_name, classifier_version, input_hash)
        where input_hash is not null;
    end if;
  end if;
end $$;
