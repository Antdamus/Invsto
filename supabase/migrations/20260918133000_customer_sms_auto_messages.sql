-- Editable automatic SMS replies for the OG Jewelers subscriber flow.

create table if not exists public.customer_sms_auto_messages (
  message_key text primary key,
  title text not null,
  description text,
  body text not null,
  fallback_body text not null,
  is_active boolean not null default true,
  updated_by uuid,
  updated_by_email text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customer_sms_auto_messages_key_check
    check (message_key ~ '^[a-z0-9_:-]{2,80}$'),
  constraint customer_sms_auto_messages_title_check
    check (length(btrim(title)) between 1 and 160),
  constraint customer_sms_auto_messages_body_check
    check (length(btrim(body)) between 1 and 1200),
  constraint customer_sms_auto_messages_fallback_body_check
    check (length(btrim(fallback_body)) between 1 and 1200),
  constraint customer_sms_auto_messages_email_check
    check (updated_by_email is null or updated_by_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

drop trigger if exists trg_customer_sms_auto_messages_updated_at on public.customer_sms_auto_messages;
create trigger trg_customer_sms_auto_messages_updated_at
before update on public.customer_sms_auto_messages
for each row execute function public.set_updated_at();

alter table public.customer_sms_auto_messages enable row level security;

drop policy if exists "customer_sms_auto_messages_admin_select" on public.customer_sms_auto_messages;
create policy "customer_sms_auto_messages_admin_select"
on public.customer_sms_auto_messages
for select
to authenticated
using (public.is_admin());

drop policy if exists "customer_sms_auto_messages_admin_insert" on public.customer_sms_auto_messages;
create policy "customer_sms_auto_messages_admin_insert"
on public.customer_sms_auto_messages
for insert
to authenticated
with check (public.is_admin());

drop policy if exists "customer_sms_auto_messages_admin_update" on public.customer_sms_auto_messages;
create policy "customer_sms_auto_messages_admin_update"
on public.customer_sms_auto_messages
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

revoke all on public.customer_sms_auto_messages from public, anon;
grant select, insert, update on public.customer_sms_auto_messages to authenticated;
grant select, insert, update, delete on public.customer_sms_auto_messages to service_role;

insert into public.customer_sms_auto_messages (
  message_key,
  title,
  description,
  body,
  fallback_body
)
values
  (
    'username_prompt',
    'Ask for eBay username',
    'Sent after someone texts OG or subscribes by text.',
    $sms$💰 WANT A CHANCE TO WIN $100 EVERY DAY? 💰

Join our VIP text list for access to our DAILY GIVEAWAYS $100 SENT VIA ZELLE 🎉🔥

To join, simply reply with your eBay username.

📲 Daily giveaways
💵 $100 sent via Zelle
🎁 Exclusive offers & surprises

Reply with your eBay username to get started! 🍀$sms$,
    $sms$💰 WANT A CHANCE TO WIN $100 EVERY DAY? 💰

Join our VIP text list for access to our DAILY GIVEAWAYS $100 SENT VIA ZELLE 🎉🔥

To join, simply reply with your eBay username.

📲 Daily giveaways
💵 $100 sent via Zelle
🎁 Exclusive offers & surprises

Reply with your eBay username to get started! 🍀$sms$
  ),
  (
    'username_saved',
    'Username received',
    'Sent after the customer sends their public eBay username.',
    $sms$🎉 CONGRATULATIONS! YOU’RE ALMOST IN! 🎉

We received your eBay username ✅

There’s just ONE LAST STEP to complete your entry for our daily $100 Zelle giveaways 💵🔥

📲 Follow us on Instagram @OGJewelers

Once you’ve followed us, reply DONE and you’re officially entered! 🍀💎$sms$,
    $sms$🎉 CONGRATULATIONS! YOU’RE ALMOST IN! 🎉

We received your eBay username ✅

There’s just ONE LAST STEP to complete your entry for our daily $100 Zelle giveaways 💵🔥

📲 Follow us on Instagram @OGJewelers

Once you’ve followed us, reply DONE and you’re officially entered! 🍀💎$sms$
  ),
  (
    'username_change_prompt',
    'Change username prompt',
    'Sent after a subscribed customer replies CHANGE.',
    'OG Jewelers: Send the new eBay username as publicly displayed. Just the public username, nothing more.',
    'OG Jewelers: Send the new eBay username as publicly displayed. Just the public username, nothing more.'
  ),
  (
    'username_status',
    'Username on file',
    'Sent when a subscribed customer already has an eBay username saved.',
    'OG Jewelers: Your eBay username on file is {{username}}. To change it, reply CHANGE.',
    'OG Jewelers: Your eBay username on file is {{username}}. To change it, reply CHANGE.'
  ),
  (
    'instagram_done',
    'Instagram DONE reply',
    'Sent after the customer replies DONE after following Instagram.',
    'OG Jewelers: You''re officially entered for our daily $100 Zelle giveaways. Good luck!',
    'OG Jewelers: You''re officially entered for our daily $100 Zelle giveaways. Good luck!'
  )
on conflict (message_key) do update
set
  title = excluded.title,
  description = excluded.description,
  fallback_body = excluded.fallback_body;

alter table public.customer_sms_events
  drop constraint if exists customer_sms_events_event_type_check;

alter table public.customer_sms_events
  add constraint customer_sms_events_event_type_check
  check (event_type in (
    'subscribe',
    'unsubscribe',
    'help',
    'unknown',
    'website_opt_in',
    'campaign_send',
    'campaign_delivered',
    'campaign_failed',
    'twilio_status',
    'ebay_username_saved',
    'ebay_username_change_requested',
    'ebay_username_rejected',
    'instagram_follow_done'
  ));

notify pgrst, 'reload schema';
