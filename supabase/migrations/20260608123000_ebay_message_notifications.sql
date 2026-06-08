-- Step 5F.6P eBay NEW_MESSAGE notification receiver storage.
-- This table is an ingress ledger for eBay Commerce Notification API events.

create table if not exists public.ebay_message_notifications (
  id uuid primary key default gen_random_uuid(),
  notification_id text,
  topic text,
  event_date timestamptz,
  publish_date timestamptz,
  publish_attempt_count integer,
  ebay_conversation_id text,
  conversation_type text check (conversation_type in ('FROM_MEMBERS', 'FROM_EBAY')),
  ebay_message_id text,
  read_status boolean,
  signature_verified boolean not null default false,
  signature_verification_error text,
  processing_status text not null default 'received'
    check (processing_status in ('received', 'ignored', 'sync_requested', 'sync_succeeded', 'sync_failed', 'signature_failed')),
  sync_run_id uuid references public.ebay_message_sync_runs(id) on delete set null,
  sync_response jsonb not null default '{}'::jsonb,
  raw_headers jsonb not null default '{}'::jsonb,
  raw_payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create unique index if not exists ebay_message_notifications_notification_id_uidx
  on public.ebay_message_notifications(notification_id)
  where notification_id is not null;

create index if not exists ebay_message_notifications_conversation_idx
  on public.ebay_message_notifications(ebay_conversation_id, received_at desc)
  where ebay_conversation_id is not null;

create index if not exists ebay_message_notifications_processing_idx
  on public.ebay_message_notifications(processing_status, received_at desc);

alter table public.ebay_message_notifications enable row level security;

revoke all on table public.ebay_message_notifications from public, anon, authenticated;
grant select on table public.ebay_message_notifications to authenticated;
grant select, insert, update on table public.ebay_message_notifications to service_role;

drop policy if exists "ebay_message_notifications_staff_select" on public.ebay_message_notifications;
create policy "ebay_message_notifications_staff_select"
on public.ebay_message_notifications
for select
to authenticated
using (public.can_manage_inventory());

comment on table public.ebay_message_notifications
  is 'Ingress ledger for eBay Notification API message events. NEW_MESSAGE payloads can target-refresh the changed conversation.';
