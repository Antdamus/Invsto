-- Canonical eBay Commerce Message persistence.
-- This is read-model infrastructure only: no send, status update, mark-read,
-- archive, delete, or Outlook mutation behavior is introduced here.

create table if not exists public.ebay_seller_accounts (
  id uuid primary key default gen_random_uuid(),
  account_key text not null unique,
  seller_username text,
  marketplace_id text not null default 'EBAY_US',
  environment text not null default 'production'
    check (environment in ('production', 'sandbox', 'unknown')),
  auth_source text not null default 'supabase_secret'
    check (auth_source in ('supabase_secret', 'oauth_connection_table', 'manual')),
  status text not null default 'active'
    check (status in ('active', 'paused', 'error', 'disconnected')),
  last_message_sync_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ebay_conversations (
  id uuid primary key default gen_random_uuid(),
  seller_account_id uuid not null references public.ebay_seller_accounts(id) on delete cascade,
  ebay_conversation_id text not null,
  conversation_type text not null
    check (conversation_type in ('FROM_MEMBERS', 'FROM_EBAY')),
  conversation_status text,
  conversation_title text,
  other_party_username text,
  reference_id text,
  reference_type text,
  unread_count integer not null default 0 check (unread_count >= 0),
  latest_message_id text,
  latest_message_created_at timestamptz,
  latest_message_preview text,
  first_message_created_at timestamptz,
  last_message_created_at timestamptz,
  message_count integer,
  last_synced_at timestamptz,
  last_detail_synced_at timestamptz,
  last_sync_run_id uuid,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  raw_summary jsonb not null default '{}'::jsonb,
  raw_detail_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (seller_account_id, conversation_type, ebay_conversation_id)
);

create table if not exists public.ebay_conversation_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.ebay_conversations(id) on delete cascade,
  seller_account_id uuid not null references public.ebay_seller_accounts(id) on delete cascade,
  ebay_conversation_id text not null,
  conversation_type text not null
    check (conversation_type in ('FROM_MEMBERS', 'FROM_EBAY')),
  ebay_message_id text not null,
  sender_username text,
  recipient_username text,
  direction text not null default 'unknown'
    check (direction in ('inbound', 'outbound', 'platform', 'unknown')),
  direction_confidence text not null default 'unknown'
    check (direction_confidence in ('strong', 'medium', 'weak', 'unknown')),
  direction_reason text,
  subject text,
  message_body text,
  message_body_sha256 text,
  message_body_preview text,
  read_status text,
  is_read boolean,
  message_status text,
  created_at_ebay timestamptz,
  message_media jsonb not null default '[]'::jsonb,
  has_media boolean not null default false,
  media_count integer not null default 0 check (media_count >= 0),
  raw_message_metadata jsonb not null default '{}'::jsonb,
  last_sync_run_id uuid,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (seller_account_id, conversation_type, ebay_conversation_id, ebay_message_id)
);

create table if not exists public.ebay_message_sync_runs (
  id uuid primary key default gen_random_uuid(),
  seller_account_id uuid references public.ebay_seller_accounts(id) on delete set null,
  run_type text not null default 'manual'
    check (run_type in ('manual', 'scheduled', 'backfill', 'incremental', 'replay')),
  status text not null default 'running'
    check (status in ('running', 'succeeded', 'failed', 'cancelled')),
  conversation_type text
    check (conversation_type in ('FROM_MEMBERS', 'FROM_EBAY')),
  started_by uuid references auth.users(id) on delete set null,
  trigger_source text not null default 'edge_function',
  requested_start_time timestamptz,
  requested_end_time timestamptz,
  requested_reference_id text,
  requested_other_party_username text,
  conversation_page_limit integer not null default 25,
  message_page_limit integer not null default 25,
  max_conversation_pages integer not null default 1,
  max_detail_pages_per_conversation integer not null default 20,
  pages_fetched integer not null default 0,
  detail_pages_fetched integer not null default 0,
  conversations_seen integer not null default 0,
  conversations_inserted integer not null default 0,
  conversations_updated integer not null default 0,
  messages_seen integer not null default 0,
  messages_inserted integer not null default 0,
  messages_updated integer not null default 0,
  media_seen integer not null default 0,
  errors integer not null default 0,
  warnings jsonb not null default '[]'::jsonb,
  last_error_code text,
  last_error_message text,
  metadata jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.ebay_conversation_links (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.ebay_conversations(id) on delete cascade,
  seller_account_id uuid not null references public.ebay_seller_accounts(id) on delete cascade,
  link_type text not null
    check (link_type in (
      'listing_reference',
      'buyer_username',
      'ebay_order',
      'ebay_order_line',
      'ebay_return_case',
      'inventory_listing',
      'outlook_email'
    )),
  link_key text not null,
  ebay_order_id uuid references public.ebay_orders(id) on delete cascade,
  ebay_order_line_id uuid references public.ebay_order_lines(id) on delete cascade,
  ebay_return_case_id uuid references public.ebay_return_cases(id) on delete cascade,
  email_message_id uuid references public.email_messages(id) on delete cascade,
  reference_id text,
  reference_type text,
  buyer_username text,
  matched_value text,
  match_method text not null default 'direct_api_field',
  confidence numeric(5,4),
  status text not null default 'confirmed'
    check (status in ('confirmed', 'suggested', 'rejected', 'stale')),
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (conversation_id, link_type, link_key)
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'ebay_conversations_last_sync_run_fk'
  ) then
    alter table public.ebay_conversations
      add constraint ebay_conversations_last_sync_run_fk
      foreign key (last_sync_run_id)
      references public.ebay_message_sync_runs(id)
      on delete set null;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'ebay_conversation_messages_last_sync_run_fk'
  ) then
    alter table public.ebay_conversation_messages
      add constraint ebay_conversation_messages_last_sync_run_fk
      foreign key (last_sync_run_id)
      references public.ebay_message_sync_runs(id)
      on delete set null;
  end if;
end;
$$;

create index if not exists ebay_seller_accounts_username_idx
  on public.ebay_seller_accounts(lower(seller_username))
  where seller_username is not null;

create index if not exists ebay_conversations_inbox_order_idx
  on public.ebay_conversations(seller_account_id, last_message_created_at desc nulls last, updated_at desc);

create index if not exists ebay_conversations_unread_idx
  on public.ebay_conversations(seller_account_id, unread_count desc, last_message_created_at desc nulls last)
  where unread_count > 0;

create index if not exists ebay_conversations_other_party_idx
  on public.ebay_conversations(seller_account_id, lower(other_party_username), last_message_created_at desc nulls last)
  where other_party_username is not null;

create index if not exists ebay_conversations_reference_idx
  on public.ebay_conversations(seller_account_id, reference_type, reference_id)
  where reference_id is not null;

create index if not exists ebay_conversation_messages_timeline_idx
  on public.ebay_conversation_messages(conversation_id, created_at_ebay asc nulls last, created_at asc);

create index if not exists ebay_conversation_messages_sender_idx
  on public.ebay_conversation_messages(seller_account_id, lower(sender_username), created_at_ebay desc nulls last)
  where sender_username is not null;

create index if not exists ebay_conversation_messages_recipient_idx
  on public.ebay_conversation_messages(seller_account_id, lower(recipient_username), created_at_ebay desc nulls last)
  where recipient_username is not null;

create index if not exists ebay_conversation_messages_media_idx
  on public.ebay_conversation_messages(seller_account_id, created_at_ebay desc nulls last)
  where has_media = true;

create index if not exists ebay_message_sync_runs_started_idx
  on public.ebay_message_sync_runs(started_at desc);

create index if not exists ebay_message_sync_runs_account_started_idx
  on public.ebay_message_sync_runs(seller_account_id, started_at desc)
  where seller_account_id is not null;

create index if not exists ebay_conversation_links_conversation_idx
  on public.ebay_conversation_links(conversation_id, status);

create index if not exists ebay_conversation_links_order_idx
  on public.ebay_conversation_links(ebay_order_id)
  where ebay_order_id is not null;

create index if not exists ebay_conversation_links_order_line_idx
  on public.ebay_conversation_links(ebay_order_line_id)
  where ebay_order_line_id is not null;

create index if not exists ebay_conversation_links_return_case_idx
  on public.ebay_conversation_links(ebay_return_case_id)
  where ebay_return_case_id is not null;

alter table public.ebay_seller_accounts enable row level security;
alter table public.ebay_conversations enable row level security;
alter table public.ebay_conversation_messages enable row level security;
alter table public.ebay_message_sync_runs enable row level security;
alter table public.ebay_conversation_links enable row level security;

revoke all on table public.ebay_seller_accounts from public, anon, authenticated;
revoke all on table public.ebay_conversations from public, anon, authenticated;
revoke all on table public.ebay_conversation_messages from public, anon, authenticated;
revoke all on table public.ebay_message_sync_runs from public, anon, authenticated;
revoke all on table public.ebay_conversation_links from public, anon, authenticated;

grant select on table public.ebay_seller_accounts to authenticated;
grant select on table public.ebay_conversations to authenticated;
grant select on table public.ebay_conversation_messages to authenticated;
grant select on table public.ebay_message_sync_runs to authenticated;
grant select on table public.ebay_conversation_links to authenticated;

grant select, insert, update, delete on table public.ebay_seller_accounts to service_role;
grant select, insert, update, delete on table public.ebay_conversations to service_role;
grant select, insert, update, delete on table public.ebay_conversation_messages to service_role;
grant select, insert, update, delete on table public.ebay_message_sync_runs to service_role;
grant select, insert, update, delete on table public.ebay_conversation_links to service_role;

drop policy if exists "ebay_seller_accounts_staff_select" on public.ebay_seller_accounts;
create policy "ebay_seller_accounts_staff_select"
on public.ebay_seller_accounts
for select
to authenticated
using (public.can_manage_inventory());

drop policy if exists "ebay_conversations_staff_select" on public.ebay_conversations;
create policy "ebay_conversations_staff_select"
on public.ebay_conversations
for select
to authenticated
using (public.can_manage_inventory());

drop policy if exists "ebay_conversation_messages_staff_select" on public.ebay_conversation_messages;
create policy "ebay_conversation_messages_staff_select"
on public.ebay_conversation_messages
for select
to authenticated
using (public.can_manage_inventory());

drop policy if exists "ebay_message_sync_runs_staff_select" on public.ebay_message_sync_runs;
create policy "ebay_message_sync_runs_staff_select"
on public.ebay_message_sync_runs
for select
to authenticated
using (public.can_manage_inventory());

drop policy if exists "ebay_conversation_links_staff_select" on public.ebay_conversation_links;
create policy "ebay_conversation_links_staff_select"
on public.ebay_conversation_links
for select
to authenticated
using (public.can_manage_inventory());

create or replace function public.touch_ebay_messaging_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_ebay_seller_accounts_updated_at on public.ebay_seller_accounts;
create trigger trg_ebay_seller_accounts_updated_at
before update on public.ebay_seller_accounts
for each row execute function public.touch_ebay_messaging_updated_at();

drop trigger if exists trg_ebay_conversations_updated_at on public.ebay_conversations;
create trigger trg_ebay_conversations_updated_at
before update on public.ebay_conversations
for each row execute function public.touch_ebay_messaging_updated_at();

drop trigger if exists trg_ebay_conversation_messages_updated_at on public.ebay_conversation_messages;
create trigger trg_ebay_conversation_messages_updated_at
before update on public.ebay_conversation_messages
for each row execute function public.touch_ebay_messaging_updated_at();

drop trigger if exists trg_ebay_conversation_links_updated_at on public.ebay_conversation_links;
create trigger trg_ebay_conversation_links_updated_at
before update on public.ebay_conversation_links
for each row execute function public.touch_ebay_messaging_updated_at();
