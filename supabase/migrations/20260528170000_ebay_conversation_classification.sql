-- Conversation-level AI classification for canonical eBay messaging.
-- Additive only. This stores operator-facing triage metadata and override
-- history; it does not send, mark read, archive, delete, or mutate eBay.

create table if not exists public.ebay_conversation_classifications (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.ebay_conversations(id) on delete cascade,
  latest_message_id uuid references public.ebay_conversation_messages(id) on delete set null,
  latest_ebay_message_id text,
  source text not null default 'ai'
    check (source in ('ai', 'operator', 'rule')),
  classification_status text not null default 'classified'
    check (classification_status in ('classified', 'failed', 'skipped')),
  priority text not null
    check (priority in ('high', 'normal', 'low')),
  response_need text not null
    check (response_need in ('reply_today', 'reply_later', 'no_reply_needed')),
  topic_tags text[] not null default '{}'::text[]
    check (topic_tags <@ array[
      'return',
      'cancellation',
      'shipping_issue',
      'payment_issue',
      'item_question',
      'missing_item',
      'wrong_item',
      'not_as_described',
      'refund_request',
      'buyer_complaint',
      'custom_order_question',
      'general_question',
      'platform_notice',
      'feedback_issue',
      'offer_question',
      'order_status',
      'delivery_timing',
      'address_change'
    ]::text[]),
  buyer_flags text[] not null default '{}'::text[]
    check (buyer_flags <@ array[
      'vip_buyer',
      'high_value_buyer',
      'repeat_buyer',
      'new_buyer',
      'high_retained_value_buyer',
      'return_prone_buyer',
      'high_return_risk_buyer',
      'low_risk_buyer'
    ]::text[]),
  risk_flags text[] not null default '{}'::text[]
    check (risk_flags <@ array[
      'refund_risk',
      'chargeback_risk',
      'negative_feedback_risk',
      'return_escalation_risk',
      'cancellation_risk',
      'buyer_unhappy',
      'context_review_needed',
      'low_confidence',
      'unsupported_claim_risk'
    ]::text[]),
  confidence numeric(5,4) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  summary text,
  reasoning_summary text,
  recommended_action text,
  input_hash text,
  context_hash text,
  classifier_name text not null default 'ebay_conversation_classifier',
  classifier_version text not null default 'v1',
  prompt_version text,
  model_name text,
  original_ai_output jsonb not null default '{}'::jsonb,
  normalized_ai_output jsonb not null default '{}'::jsonb,
  input_snapshot jsonb not null default '{}'::jsonb,
  validation_metadata jsonb not null default '{}'::jsonb,
  is_current boolean not null default true,
  superseded_at timestamptz,
  review_state text not null default 'pending_review'
    check (review_state in ('pending_review', 'approved', 'corrected', 'dismissed')),
  operator_override_payload jsonb not null default '{}'::jsonb,
  operator_notes text,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ebay_conversation_classification_overrides (
  id uuid primary key default gen_random_uuid(),
  classification_id uuid not null references public.ebay_conversation_classifications(id) on delete cascade,
  conversation_id uuid not null references public.ebay_conversations(id) on delete cascade,
  event_type text not null default 'corrected'
    check (event_type in ('approved', 'corrected', 'dismissed', 'review_saved')),
  previous_state jsonb not null default '{}'::jsonb,
  override_payload jsonb not null default '{}'::jsonb,
  new_state jsonb not null default '{}'::jsonb,
  operator_notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_by_email text,
  created_at timestamptz not null default now()
);

create unique index if not exists ebay_conversation_classifications_current_uidx
  on public.ebay_conversation_classifications(conversation_id)
  where is_current = true;

create index if not exists ebay_conversation_classifications_conversation_created_idx
  on public.ebay_conversation_classifications(conversation_id, created_at desc);

create index if not exists ebay_conversation_classifications_priority_response_idx
  on public.ebay_conversation_classifications(priority, response_need, created_at desc)
  where is_current = true;

create index if not exists ebay_conversation_classifications_topic_tags_idx
  on public.ebay_conversation_classifications using gin(topic_tags)
  where is_current = true;

create index if not exists ebay_conversation_classifications_buyer_flags_idx
  on public.ebay_conversation_classifications using gin(buyer_flags)
  where is_current = true;

create index if not exists ebay_conversation_classifications_risk_flags_idx
  on public.ebay_conversation_classifications using gin(risk_flags)
  where is_current = true;

create index if not exists ebay_conversation_classifications_input_hash_idx
  on public.ebay_conversation_classifications(input_hash)
  where input_hash is not null;

create index if not exists ebay_conversation_classification_overrides_classification_idx
  on public.ebay_conversation_classification_overrides(classification_id, created_at desc);

create index if not exists ebay_conversation_classification_overrides_conversation_idx
  on public.ebay_conversation_classification_overrides(conversation_id, created_at desc);

alter table public.ebay_conversation_classifications enable row level security;
alter table public.ebay_conversation_classification_overrides enable row level security;

revoke all on table public.ebay_conversation_classifications from public, anon, authenticated;
revoke all on table public.ebay_conversation_classification_overrides from public, anon, authenticated;

grant select on table public.ebay_conversation_classifications to authenticated;
grant select on table public.ebay_conversation_classification_overrides to authenticated;

grant select, insert, update, delete on table public.ebay_conversation_classifications to service_role;
grant select, insert, update, delete on table public.ebay_conversation_classification_overrides to service_role;

drop policy if exists "ebay_conversation_classifications_staff_select" on public.ebay_conversation_classifications;
create policy "ebay_conversation_classifications_staff_select"
on public.ebay_conversation_classifications
for select
to authenticated
using (public.can_manage_inventory());

drop policy if exists "ebay_conversation_classification_overrides_staff_select" on public.ebay_conversation_classification_overrides;
create policy "ebay_conversation_classification_overrides_staff_select"
on public.ebay_conversation_classification_overrides
for select
to authenticated
using (public.can_manage_inventory());

drop trigger if exists trg_ebay_conversation_classifications_updated_at on public.ebay_conversation_classifications;
create trigger trg_ebay_conversation_classifications_updated_at
before update on public.ebay_conversation_classifications
for each row execute function public.touch_ebay_messaging_updated_at();
