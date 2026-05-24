create table if not exists public.ebay_account_deletion_notifications (
  id uuid primary key default gen_random_uuid(),
  notification_id text,
  username text,
  eias_token text,
  raw_payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_notes text
);

create index if not exists ebay_account_deletion_notifications_username_idx
  on public.ebay_account_deletion_notifications(username);

create index if not exists ebay_account_deletion_notifications_received_at_idx
  on public.ebay_account_deletion_notifications(received_at desc);

alter table public.ebay_account_deletion_notifications enable row level security;

grant select on public.ebay_account_deletion_notifications to authenticated;

drop policy if exists "ebay_account_deletion_notifications_inventory_staff_select"
on public.ebay_account_deletion_notifications;

create policy "ebay_account_deletion_notifications_inventory_staff_select"
on public.ebay_account_deletion_notifications
for select
using (public.can_manage_inventory());
