-- User-created smart folders for canonical eBay conversation triage.
-- Additive only: this stores reusable filter payloads and never mutates eBay.

create table if not exists public.ebay_conversation_saved_views (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 80),
  description text,
  filter_payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(filter_payload) = 'object'),
  system_key text,
  is_system_default boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 100,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  updated_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index if not exists ebay_conversation_saved_views_system_key_uidx
  on public.ebay_conversation_saved_views(system_key)
  where system_key is not null;

create unique index if not exists ebay_conversation_saved_views_active_name_uidx
  on public.ebay_conversation_saved_views(lower(trim(name)))
  where deleted_at is null and is_active = true;

create index if not exists ebay_conversation_saved_views_sort_idx
  on public.ebay_conversation_saved_views(is_system_default desc, sort_order, lower(name))
  where deleted_at is null and is_active = true;

alter table public.ebay_conversation_saved_views enable row level security;

revoke all on table public.ebay_conversation_saved_views from public, anon, authenticated;

grant select, insert, update on table public.ebay_conversation_saved_views to authenticated;
grant select, insert, update, delete on table public.ebay_conversation_saved_views to service_role;

drop policy if exists "ebay_conversation_saved_views_staff_select" on public.ebay_conversation_saved_views;
create policy "ebay_conversation_saved_views_staff_select"
on public.ebay_conversation_saved_views
for select
to authenticated
using (public.can_manage_inventory());

drop policy if exists "ebay_conversation_saved_views_staff_insert" on public.ebay_conversation_saved_views;
create policy "ebay_conversation_saved_views_staff_insert"
on public.ebay_conversation_saved_views
for insert
to authenticated
with check (public.can_manage_inventory());

drop policy if exists "ebay_conversation_saved_views_staff_update" on public.ebay_conversation_saved_views;
create policy "ebay_conversation_saved_views_staff_update"
on public.ebay_conversation_saved_views
for update
to authenticated
using (public.can_manage_inventory())
with check (public.can_manage_inventory());

drop trigger if exists trg_ebay_conversation_saved_views_updated_at on public.ebay_conversation_saved_views;
create trigger trg_ebay_conversation_saved_views_updated_at
before update on public.ebay_conversation_saved_views
for each row execute function public.touch_ebay_messaging_updated_at();

insert into public.ebay_conversation_saved_views
  (name, description, filter_payload, system_key, is_system_default, sort_order)
values
  (
    'All',
    'All canonical eBay conversations.',
    '{"version":1,"system_filter":"all","search_query":"","classification_filters":{"topics":[],"buyerFlags":[],"riskFlags":[],"priorities":[],"responseNeeds":[]}}'::jsonb,
    'all',
    true,
    10
  ),
  (
    'Unread',
    'Conversations with unread eBay count.',
    '{"version":1,"system_filter":"unread","search_query":"","classification_filters":{"topics":[],"buyerFlags":[],"riskFlags":[],"priorities":[],"responseNeeds":[]}}'::jsonb,
    'unread',
    true,
    20
  ),
  (
    'Returns',
    'Return-linked or return-classified conversations.',
    '{"version":1,"system_filter":"returns","search_query":"","classification_filters":{"topics":[],"buyerFlags":[],"riskFlags":[],"priorities":[],"responseNeeds":[]}}'::jsonb,
    'returns',
    true,
    30
  ),
  (
    'Shipping',
    'Shipping issue and delivery timing conversations.',
    '{"version":1,"system_filter":"shipping_issues","search_query":"","classification_filters":{"topics":[],"buyerFlags":[],"riskFlags":[],"priorities":[],"responseNeeds":[]}}'::jsonb,
    'shipping_issues',
    true,
    40
  ),
  (
    'Reply today',
    'Conversations classified as needing a reply today.',
    '{"version":1,"system_filter":"needs_reply_today","search_query":"","classification_filters":{"topics":[],"buyerFlags":[],"riskFlags":[],"priorities":[],"responseNeeds":[]}}'::jsonb,
    'needs_reply_today',
    true,
    50
  ),
  (
    'VIP buyers',
    'Conversations with VIP buyer signals.',
    '{"version":1,"system_filter":"vip_buyers","search_query":"","classification_filters":{"topics":[],"buyerFlags":[],"riskFlags":[],"priorities":[],"responseNeeds":[]}}'::jsonb,
    'vip_buyers',
    true,
    60
  ),
  (
    'High value',
    'Conversations with high-value buyer signals.',
    '{"version":1,"system_filter":"high_value_buyers","search_query":"","classification_filters":{"topics":[],"buyerFlags":[],"riskFlags":[],"priorities":[],"responseNeeds":[]}}'::jsonb,
    'high_value_buyers',
    true,
    70
  ),
  (
    'Refund risk',
    'Conversations with refund or chargeback risk signals.',
    '{"version":1,"system_filter":"refund_risk","search_query":"","classification_filters":{"topics":[],"buyerFlags":[],"riskFlags":[],"priorities":[],"responseNeeds":[]}}'::jsonb,
    'refund_risk',
    true,
    80
  ),
  (
    'Review queue',
    'Unclassified, stale, or context-review conversations.',
    '{"version":1,"system_filter":"review_queue","search_query":"","classification_filters":{"topics":[],"buyerFlags":[],"riskFlags":[],"priorities":[],"responseNeeds":[]}}'::jsonb,
    'review_queue',
    true,
    90
  ),
  (
    'Has order',
    'Conversations linked to an order.',
    '{"version":1,"system_filter":"has_order","search_query":"","classification_filters":{"topics":[],"buyerFlags":[],"riskFlags":[],"priorities":[],"responseNeeds":[]}}'::jsonb,
    'has_order',
    true,
    100
  ),
  (
    'Has return',
    'Conversations linked to a return.',
    '{"version":1,"system_filter":"has_return","search_query":"","classification_filters":{"topics":[],"buyerFlags":[],"riskFlags":[],"priorities":[],"responseNeeds":[]}}'::jsonb,
    'has_return',
    true,
    110
  ),
  (
    'Has media',
    'Conversations with eBay message attachments.',
    '{"version":1,"system_filter":"has_media","search_query":"","classification_filters":{"topics":[],"buyerFlags":[],"riskFlags":[],"priorities":[],"responseNeeds":[]}}'::jsonb,
    'has_media',
    true,
    120
  ),
  (
    'Needs review',
    'Conversations needing context review.',
    '{"version":1,"system_filter":"needs_context_review","search_query":"","classification_filters":{"topics":[],"buyerFlags":[],"riskFlags":[],"priorities":[],"responseNeeds":[]}}'::jsonb,
    'needs_context_review',
    true,
    130
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
