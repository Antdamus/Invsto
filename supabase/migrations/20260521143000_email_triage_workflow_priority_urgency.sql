-- Step 4B.6.8 workflow priority and urgency layer.
-- Additive only: preserves existing classification fields while adding
-- operator-assist workflow metadata for triage prioritization.

alter table public.email_message_classifications
  add column if not exists priority_level text,
  add column if not exists urgency_level text,
  add column if not exists response_timing text,
  add column if not exists customer_risk text,
  add column if not exists refund_risk boolean not null default false,
  add column if not exists chargeback_risk boolean not null default false;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.email_message_classifications'::regclass
      and conname = 'email_message_classifications_priority_level_check'
  ) then
    alter table public.email_message_classifications
      add constraint email_message_classifications_priority_level_check
      check (priority_level is null or priority_level in ('low', 'medium', 'high', 'critical'))
      not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.email_message_classifications'::regclass
      and conname = 'email_message_classifications_urgency_level_check'
  ) then
    alter table public.email_message_classifications
      add constraint email_message_classifications_urgency_level_check
      check (urgency_level is null or urgency_level in ('low', 'today', 'immediate'))
      not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.email_message_classifications'::regclass
      and conname = 'email_message_classifications_response_timing_check'
  ) then
    alter table public.email_message_classifications
      add constraint email_message_classifications_response_timing_check
      check (
        response_timing is null or response_timing in (
          'no_response_needed',
          'within_72_hours',
          'within_24_hours',
          'immediate_attention'
        )
      )
      not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.email_message_classifications'::regclass
      and conname = 'email_message_classifications_customer_risk_check'
  ) then
    alter table public.email_message_classifications
      add constraint email_message_classifications_customer_risk_check
      check (customer_risk is null or customer_risk in ('low', 'medium', 'high', 'critical'))
      not valid;
  end if;
end $$;

create index if not exists email_message_classifications_workflow_priority_idx
  on public.email_message_classifications(priority_level, urgency_level, response_timing, created_at desc);

create index if not exists email_message_classifications_workflow_risk_idx
  on public.email_message_classifications(refund_risk, chargeback_risk, customer_risk, created_at desc);
