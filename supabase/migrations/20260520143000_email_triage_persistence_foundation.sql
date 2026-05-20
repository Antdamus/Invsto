-- Email Triage durable persistence foundation.
-- This migration creates provider-neutral mailbox, folder, message metadata,
-- sync checkpoint, audit, processing, classification, and linking tables.
-- OAuth token material remains only in microsoft_mailbox_connection_secrets.

create table if not exists public.email_mailboxes (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('microsoft', 'gmail')),
  microsoft_connection_id uuid references public.microsoft_mailbox_connections(id) on delete set null,
  mailbox_email text not null,
  display_name text,
  status text not null default 'active'
    check (status in ('active', 'paused', 'error', 'disconnected')),
  sync_enabled boolean not null default true,
  connected_by uuid references auth.users(id) on delete set null,
  last_sync_at timestamptz,
  last_error_code text,
  last_error_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.email_folders (
  id uuid primary key default gen_random_uuid(),
  mailbox_id uuid not null references public.email_mailboxes(id) on delete cascade,
  provider_folder_id text not null,
  well_known_name text,
  display_name text,
  parent_provider_folder_id text,
  total_item_count integer,
  unread_item_count integer,
  is_sync_enabled boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (mailbox_id, provider_folder_id)
);

create table if not exists public.email_messages (
  id uuid primary key default gen_random_uuid(),
  mailbox_id uuid not null references public.email_mailboxes(id) on delete cascade,
  folder_id uuid references public.email_folders(id) on delete set null,
  provider text not null default 'microsoft' check (provider in ('microsoft', 'gmail')),
  provider_message_id text not null,
  provider_immutable_id text,
  internet_message_id text,
  conversation_id text,
  conversation_index text,
  subject text,
  subject_normalized text,
  from_name text,
  from_email text,
  sender_name text,
  sender_email text,
  reply_to_emails text[] not null default '{}',
  received_at timestamptz,
  sent_at timestamptz,
  created_date_time timestamptz,
  last_modified_date_time timestamptz,
  web_link text,
  importance text,
  inference_classification text,
  is_read boolean,
  is_draft boolean,
  has_attachments boolean not null default false,
  body_preview text,
  body_content_type text,
  graph_etag text,
  graph_change_key text,
  sync_status text not null default 'active'
    check (sync_status in ('active', 'deleted', 'tombstone', 'failed')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  deleted_at timestamptz,
  raw_graph_metadata jsonb not null default '{}'::jsonb,
  unique (mailbox_id, provider_message_id)
);

create table if not exists public.email_message_recipients (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.email_messages(id) on delete cascade,
  recipient_type text not null
    check (recipient_type in ('from', 'sender', 'to', 'cc', 'bcc', 'reply_to')),
  display_name text,
  email text not null,
  email_normalized text not null,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  unique (message_id, recipient_type, email_normalized, position)
);

create table if not exists public.email_message_bodies (
  message_id uuid primary key references public.email_messages(id) on delete cascade,
  body_text text,
  body_html text,
  body_text_sha256 text,
  body_html_sha256 text,
  normalized_text text,
  normalized_text_sha256 text,
  normalization_version text,
  redaction_status text not null default 'unredacted'
    check (redaction_status in ('unredacted', 'redacted', 'body_omitted')),
  metadata jsonb not null default '{}'::jsonb,
  stored_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.email_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.email_messages(id) on delete cascade,
  provider_attachment_id text not null,
  name text,
  content_type text,
  size_bytes bigint,
  is_inline boolean not null default false,
  content_id text,
  content_location text,
  download_status text not null default 'metadata_only'
    check (download_status in ('metadata_only', 'queued', 'stored', 'failed', 'skipped')),
  storage_bucket text,
  storage_path text,
  sha256 text,
  last_error_code text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (message_id, provider_attachment_id)
);

create table if not exists public.email_sync_states (
  id uuid primary key default gen_random_uuid(),
  mailbox_id uuid not null references public.email_mailboxes(id) on delete cascade,
  folder_id uuid references public.email_folders(id) on delete cascade,
  sync_scope text not null default 'folder_messages',
  delta_link text,
  delta_token_hash text,
  last_successful_sync_at timestamptz,
  last_attempted_sync_at timestamptz,
  last_page_started_at timestamptz,
  last_page_completed_at timestamptz,
  status text not null default 'never_synced'
    check (status in ('never_synced', 'syncing', 'idle', 'error', 'reset_required', 'paused')),
  last_error_code text,
  last_error_at timestamptz,
  consecutive_error_count integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (mailbox_id, folder_id, sync_scope)
);

create table if not exists public.email_sync_runs (
  id uuid primary key default gen_random_uuid(),
  mailbox_id uuid not null references public.email_mailboxes(id) on delete cascade,
  folder_id uuid references public.email_folders(id) on delete set null,
  sync_state_id uuid references public.email_sync_states(id) on delete set null,
  run_type text not null
    check (run_type in ('initial_backfill', 'incremental', 'manual_resync', 'webhook', 'replay', 'bootstrap')),
  status text not null default 'running'
    check (status in ('running', 'succeeded', 'failed', 'cancelled')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  started_by uuid references auth.users(id) on delete set null,
  trigger_source text not null default 'edge_function',
  graph_request_count integer not null default 0,
  pages_fetched integer not null default 0,
  messages_seen integer not null default 0,
  messages_inserted integer not null default 0,
  messages_updated integer not null default 0,
  messages_deleted integer not null default 0,
  attachments_seen integer not null default 0,
  jobs_enqueued integer not null default 0,
  last_error_code text,
  last_error_message text,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.email_processing_jobs (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.email_messages(id) on delete cascade,
  job_type text not null
    check (job_type in ('normalize', 'match_order', 'classify', 'draft_response', 'embed')),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed', 'skipped')),
  priority integer not null default 100,
  attempt_count integer not null default 0,
  max_attempts integer not null default 3,
  available_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  locked_by text,
  locked_at timestamptz,
  last_error_code text,
  last_error_message text,
  input_version text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (message_id, job_type, input_version)
);

create table if not exists public.email_message_classifications (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.email_messages(id) on delete cascade,
  source text not null check (source in ('ai', 'human', 'rule')),
  classifier_name text,
  classifier_version text,
  category text not null,
  subcategory text,
  confidence numeric(5,4),
  sentiment text,
  priority text,
  requires_human_review boolean not null default true,
  reasoning_summary text,
  evidence jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.email_message_links (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.email_messages(id) on delete cascade,
  link_type text not null
    check (link_type in ('ebay_order', 'ebay_order_line', 'inventory_item', 'sale', 'customer_identity')),
  ebay_order_id uuid references public.ebay_orders(id) on delete cascade,
  ebay_order_line_id uuid references public.ebay_order_lines(id) on delete cascade,
  item_id uuid references public.item_types(id) on delete set null,
  sale_id uuid references public.sales(id) on delete set null,
  matched_value text,
  match_method text not null,
  confidence numeric(5,4),
  status text not null default 'suggested'
    check (status in ('suggested', 'confirmed', 'rejected', 'stale')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create unique index if not exists email_mailboxes_provider_email_active_uidx
  on public.email_mailboxes (provider, lower(mailbox_email))
  where status <> 'disconnected';

create unique index if not exists email_mailboxes_microsoft_connection_uidx
  on public.email_mailboxes (microsoft_connection_id)
  where microsoft_connection_id is not null;

create index if not exists email_mailboxes_status_sync_idx
  on public.email_mailboxes(status, sync_enabled, updated_at desc);

create index if not exists email_folders_mailbox_well_known_idx
  on public.email_folders(mailbox_id, well_known_name);

create index if not exists email_folders_mailbox_sync_enabled_idx
  on public.email_folders(mailbox_id, is_sync_enabled);

create unique index if not exists email_messages_mailbox_provider_immutable_uidx
  on public.email_messages(mailbox_id, provider_immutable_id)
  where provider_immutable_id is not null;

create unique index if not exists email_messages_mailbox_internet_message_uidx
  on public.email_messages(mailbox_id, internet_message_id)
  where internet_message_id is not null;

create index if not exists email_messages_mailbox_received_idx
  on public.email_messages(mailbox_id, received_at desc);

create index if not exists email_messages_mailbox_conversation_received_idx
  on public.email_messages(mailbox_id, conversation_id, received_at);

create index if not exists email_messages_mailbox_from_received_idx
  on public.email_messages(mailbox_id, from_email, received_at desc);

create index if not exists email_messages_mailbox_subject_normalized_idx
  on public.email_messages(mailbox_id, subject_normalized);

create index if not exists email_messages_sync_status_seen_idx
  on public.email_messages(sync_status, last_seen_at desc);

create index if not exists email_message_recipients_email_type_idx
  on public.email_message_recipients(email_normalized, recipient_type);

create index if not exists email_message_recipients_message_type_idx
  on public.email_message_recipients(message_id, recipient_type);

create index if not exists email_attachments_download_status_idx
  on public.email_attachments(download_status, created_at);

create index if not exists email_attachments_message_inline_idx
  on public.email_attachments(message_id, is_inline);

create index if not exists email_sync_states_status_attempted_idx
  on public.email_sync_states(status, last_attempted_sync_at);

create index if not exists email_sync_states_mailbox_updated_idx
  on public.email_sync_states(mailbox_id, updated_at desc);

create index if not exists email_sync_runs_mailbox_started_idx
  on public.email_sync_runs(mailbox_id, started_at desc);

create index if not exists email_sync_runs_status_started_idx
  on public.email_sync_runs(status, started_at desc);

create index if not exists email_sync_runs_type_started_idx
  on public.email_sync_runs(run_type, started_at desc);

create index if not exists email_processing_jobs_status_available_idx
  on public.email_processing_jobs(status, available_at, priority);

create index if not exists email_processing_jobs_message_type_created_idx
  on public.email_processing_jobs(message_id, job_type, created_at desc);

create unique index if not exists email_processing_jobs_message_type_input_version_uidx
  on public.email_processing_jobs(message_id, job_type, coalesce(input_version, ''));

create index if not exists email_message_classifications_message_created_idx
  on public.email_message_classifications(message_id, created_at desc);

create index if not exists email_message_classifications_category_confidence_idx
  on public.email_message_classifications(category, confidence desc);

create index if not exists email_message_classifications_review_created_idx
  on public.email_message_classifications(requires_human_review, created_at desc);

create index if not exists email_message_links_message_status_idx
  on public.email_message_links(message_id, status);

create index if not exists email_message_links_ebay_order_idx
  on public.email_message_links(ebay_order_id)
  where ebay_order_id is not null;

create index if not exists email_message_links_ebay_order_line_idx
  on public.email_message_links(ebay_order_line_id)
  where ebay_order_line_id is not null;

create index if not exists email_message_links_item_idx
  on public.email_message_links(item_id)
  where item_id is not null;

create index if not exists email_message_links_sale_idx
  on public.email_message_links(sale_id)
  where sale_id is not null;

create unique index if not exists email_message_links_dedupe_uidx
  on public.email_message_links(
    message_id,
    link_type,
    coalesce(ebay_order_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(ebay_order_line_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(item_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(sale_id, '00000000-0000-0000-0000-000000000000'::uuid),
    status
  );

alter table public.email_mailboxes enable row level security;
alter table public.email_folders enable row level security;
alter table public.email_messages enable row level security;
alter table public.email_message_recipients enable row level security;
alter table public.email_message_bodies enable row level security;
alter table public.email_attachments enable row level security;
alter table public.email_sync_states enable row level security;
alter table public.email_sync_runs enable row level security;
alter table public.email_processing_jobs enable row level security;
alter table public.email_message_classifications enable row level security;
alter table public.email_message_links enable row level security;

revoke all on table public.email_mailboxes from public, anon, authenticated;
revoke all on table public.email_folders from public, anon, authenticated;
revoke all on table public.email_messages from public, anon, authenticated;
revoke all on table public.email_message_recipients from public, anon, authenticated;
revoke all on table public.email_message_bodies from public, anon, authenticated;
revoke all on table public.email_attachments from public, anon, authenticated;
revoke all on table public.email_sync_states from public, anon, authenticated;
revoke all on table public.email_sync_runs from public, anon, authenticated;
revoke all on table public.email_processing_jobs from public, anon, authenticated;
revoke all on table public.email_message_classifications from public, anon, authenticated;
revoke all on table public.email_message_links from public, anon, authenticated;

grant select on table public.email_mailboxes to authenticated;
grant select on table public.email_folders to authenticated;
grant select on table public.email_messages to authenticated;
grant select on table public.email_message_recipients to authenticated;
grant select on table public.email_attachments to authenticated;
grant select on table public.email_sync_runs to authenticated;
grant select on table public.email_processing_jobs to authenticated;
grant select on table public.email_message_classifications to authenticated;
grant select on table public.email_message_links to authenticated;

grant select, insert, update, delete on table public.email_mailboxes to service_role;
grant select, insert, update, delete on table public.email_folders to service_role;
grant select, insert, update, delete on table public.email_messages to service_role;
grant select, insert, update, delete on table public.email_message_recipients to service_role;
grant select, insert, update, delete on table public.email_message_bodies to service_role;
grant select, insert, update, delete on table public.email_attachments to service_role;
grant select, insert, update, delete on table public.email_sync_states to service_role;
grant select, insert, update, delete on table public.email_sync_runs to service_role;
grant select, insert, update, delete on table public.email_processing_jobs to service_role;
grant select, insert, update, delete on table public.email_message_classifications to service_role;
grant select, insert, update, delete on table public.email_message_links to service_role;

drop policy if exists "email_mailboxes_admin_select" on public.email_mailboxes;
create policy "email_mailboxes_admin_select"
on public.email_mailboxes
for select
to authenticated
using (public.is_admin());

drop policy if exists "email_folders_admin_select" on public.email_folders;
create policy "email_folders_admin_select"
on public.email_folders
for select
to authenticated
using (public.is_admin());

drop policy if exists "email_messages_admin_select" on public.email_messages;
create policy "email_messages_admin_select"
on public.email_messages
for select
to authenticated
using (public.is_admin());

drop policy if exists "email_message_recipients_admin_select" on public.email_message_recipients;
create policy "email_message_recipients_admin_select"
on public.email_message_recipients
for select
to authenticated
using (public.is_admin());

drop policy if exists "email_attachments_admin_select" on public.email_attachments;
create policy "email_attachments_admin_select"
on public.email_attachments
for select
to authenticated
using (public.is_admin());

drop policy if exists "email_sync_runs_admin_select" on public.email_sync_runs;
create policy "email_sync_runs_admin_select"
on public.email_sync_runs
for select
to authenticated
using (public.is_admin());

drop policy if exists "email_processing_jobs_admin_select" on public.email_processing_jobs;
create policy "email_processing_jobs_admin_select"
on public.email_processing_jobs
for select
to authenticated
using (public.is_admin());

drop policy if exists "email_message_classifications_admin_select" on public.email_message_classifications;
create policy "email_message_classifications_admin_select"
on public.email_message_classifications
for select
to authenticated
using (public.is_admin());

drop policy if exists "email_message_links_admin_select" on public.email_message_links;
create policy "email_message_links_admin_select"
on public.email_message_links
for select
to authenticated
using (public.is_admin());

drop trigger if exists trg_email_mailboxes_updated_at on public.email_mailboxes;
create trigger trg_email_mailboxes_updated_at
before update on public.email_mailboxes
for each row execute function public.set_updated_at();

drop trigger if exists trg_email_folders_updated_at on public.email_folders;
create trigger trg_email_folders_updated_at
before update on public.email_folders
for each row execute function public.set_updated_at();

drop trigger if exists trg_email_message_bodies_updated_at on public.email_message_bodies;
create trigger trg_email_message_bodies_updated_at
before update on public.email_message_bodies
for each row execute function public.set_updated_at();

drop trigger if exists trg_email_attachments_updated_at on public.email_attachments;
create trigger trg_email_attachments_updated_at
before update on public.email_attachments
for each row execute function public.set_updated_at();

drop trigger if exists trg_email_sync_states_updated_at on public.email_sync_states;
create trigger trg_email_sync_states_updated_at
before update on public.email_sync_states
for each row execute function public.set_updated_at();

drop trigger if exists trg_email_processing_jobs_updated_at on public.email_processing_jobs;
create trigger trg_email_processing_jobs_updated_at
before update on public.email_processing_jobs
for each row execute function public.set_updated_at();
