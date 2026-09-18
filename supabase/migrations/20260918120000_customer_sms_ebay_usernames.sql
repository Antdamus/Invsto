-- Capture public eBay usernames from opted-in SMS subscribers.

alter table public.customer_sms_subscribers
  add column if not exists ebay_username text,
  add column if not exists ebay_username_collected_at timestamptz,
  add column if not exists ebay_username_source text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'customer_sms_subscribers_ebay_username_check'
      and conrelid = 'public.customer_sms_subscribers'::regclass
  ) then
    alter table public.customer_sms_subscribers
      add constraint customer_sms_subscribers_ebay_username_check
      check (
        ebay_username is null
        or ebay_username ~ '^[A-Za-z0-9._-]{2,64}$'
      );
  end if;
end;
$$;

create index if not exists customer_sms_subscribers_ebay_username_idx
  on public.customer_sms_subscribers(lower(ebay_username))
  where ebay_username is not null;

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
    'ebay_username_rejected'
  ));

notify pgrst, 'reload schema';
