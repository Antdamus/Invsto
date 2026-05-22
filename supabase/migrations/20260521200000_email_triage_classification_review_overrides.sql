-- Step 4B.7 human feedback / classification override workflow.
-- Additive only: preserves immutable AI classifications and stores operator
-- review state plus effective operational overlays separately.

alter table public.email_message_classifications
  add column if not exists classification_review_state text not null default 'pending_review',
  add column if not exists operator_override_category text,
  add column if not exists operator_override_priority text,
  add column if not exists operator_override_urgency text,
  add column if not exists operator_notes text,
  add column if not exists reviewed_by uuid references auth.users(id) on delete set null,
  add column if not exists reviewed_at timestamptz,
  add column if not exists review_metadata jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.email_message_classifications'::regclass
      and conname = 'email_message_classifications_review_state_check'
  ) then
    alter table public.email_message_classifications
      add constraint email_message_classifications_review_state_check
      check (classification_review_state in ('pending_review', 'approved', 'corrected', 'dismissed'))
      not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.email_message_classifications'::regclass
      and conname = 'email_message_classifications_override_category_check'
  ) then
    alter table public.email_message_classifications
      add constraint email_message_classifications_override_category_check
      check (
        operator_override_category is null or operator_override_category in (
          'buyer_message',
          'order_paid',
          'shipping_label',
          'shipping_issue',
          'return_request',
          'refund_request',
          'cancellation_request',
          'item_not_received',
          'item_not_as_described',
          'payment_issue',
          'offer_or_negotiation',
          'inventory_question',
          'authenticity_or_condition_question',
          'platform_notice',
          'account_security',
          'marketing_or_promotion',
          'spam_or_noise',
          'internal_or_other'
        )
      )
      not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.email_message_classifications'::regclass
      and conname = 'email_message_classifications_override_priority_check'
  ) then
    alter table public.email_message_classifications
      add constraint email_message_classifications_override_priority_check
      check (operator_override_priority is null or operator_override_priority in ('low', 'medium', 'high', 'critical'))
      not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.email_message_classifications'::regclass
      and conname = 'email_message_classifications_override_urgency_check'
  ) then
    alter table public.email_message_classifications
      add constraint email_message_classifications_override_urgency_check
      check (operator_override_urgency is null or operator_override_urgency in ('none', 'later', 'soon', 'today', 'immediate'))
      not valid;
  end if;
end $$;

create table if not exists public.email_classification_review_events (
  id uuid primary key default gen_random_uuid(),
  classification_id uuid not null references public.email_message_classifications(id) on delete cascade,
  message_id uuid not null references public.email_messages(id) on delete cascade,
  event_type text not null
    check (event_type in ('review_saved', 'approved', 'corrected', 'dismissed')),
  previous_state jsonb not null default '{}'::jsonb,
  new_state jsonb not null default '{}'::jsonb,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_by_email text,
  created_at timestamptz not null default now()
);

alter table public.email_classification_review_events enable row level security;

revoke all on table public.email_classification_review_events from public, anon, authenticated;
grant select on table public.email_classification_review_events to authenticated;
grant select, insert, update, delete on table public.email_classification_review_events to service_role;

drop policy if exists "email_classification_review_events_admin_select" on public.email_classification_review_events;
create policy "email_classification_review_events_admin_select"
on public.email_classification_review_events
for select
to authenticated
using (public.is_admin_user());

create index if not exists email_message_classifications_review_state_idx
  on public.email_message_classifications(classification_review_state, reviewed_at desc, created_at desc);

create index if not exists email_message_classifications_reviewed_by_idx
  on public.email_message_classifications(reviewed_by, reviewed_at desc)
  where reviewed_by is not null;

create index if not exists email_classification_review_events_classification_created_idx
  on public.email_classification_review_events(classification_id, created_at desc);

create index if not exists email_classification_review_events_message_created_idx
  on public.email_classification_review_events(message_id, created_at desc);
