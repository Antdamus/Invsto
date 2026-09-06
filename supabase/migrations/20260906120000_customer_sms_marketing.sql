-- Customer SMS marketing opt-in, inbound keyword, and campaign tracking.
-- Keeps public/customer marketing consent separate from employee task SMS.

create table if not exists public.customer_sms_subscribers (
  id uuid primary key default gen_random_uuid(),
  phone_e164 text not null unique,
  name text,
  email text,
  source text,
  campaign text,
  status text not null default 'subscribed',
  sms_consent boolean not null default false,
  consent_source text,
  consent_text text,
  opted_in_at timestamptz,
  opted_out_at timestamptz,
  opt_out_source text,
  last_inbound_body text,
  last_inbound_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customer_sms_subscribers_phone_e164_check
    check (phone_e164 ~ '^\+\d{7,15}$'),
  constraint customer_sms_subscribers_status_check
    check (status in ('subscribed', 'unsubscribed')),
  constraint customer_sms_subscribers_email_check
    check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  constraint customer_sms_subscribers_consent_text_check
    check (consent_text is null or length(consent_text) <= 1000)
);

create table if not exists public.customer_sms_events (
  id uuid primary key default gen_random_uuid(),
  subscriber_id uuid references public.customer_sms_subscribers(id) on delete set null,
  phone_e164 text not null,
  from_phone text,
  to_phone text,
  direction text not null,
  event_type text not null,
  body text,
  provider_message_sid text,
  twilio_status text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint customer_sms_events_phone_e164_check
    check (phone_e164 ~ '^\+\d{7,15}$'),
  constraint customer_sms_events_direction_check
    check (direction in ('inbound', 'outbound', 'system')),
  constraint customer_sms_events_event_type_check
    check (event_type in (
      'subscribe',
      'unsubscribe',
      'help',
      'unknown',
      'website_opt_in',
      'campaign_send',
      'campaign_delivered',
      'campaign_failed',
      'twilio_status'
    ))
);

create table if not exists public.customer_sms_campaigns (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  link_url text,
  final_body text not null,
  status text not null default 'draft',
  recipient_count integer not null default 0,
  sent_count integer not null default 0,
  failed_count integer not null default 0,
  skipped_count integer not null default 0,
  created_by uuid,
  created_by_email text,
  started_at timestamptz,
  completed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customer_sms_campaigns_status_check
    check (status in ('draft', 'sending', 'sent', 'partial_failed', 'failed', 'cancelled')),
  constraint customer_sms_campaigns_body_check
    check (length(btrim(final_body)) between 1 and 480),
  constraint customer_sms_campaigns_email_check
    check (created_by_email is null or created_by_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

create table if not exists public.customer_sms_campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.customer_sms_campaigns(id) on delete cascade,
  subscriber_id uuid references public.customer_sms_subscribers(id) on delete set null,
  phone_e164 text not null,
  body text not null,
  status text not null default 'queued',
  provider_message_sid text,
  twilio_status text,
  error_message text,
  attempted_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customer_sms_campaign_recipients_phone_e164_check
    check (phone_e164 ~ '^\+\d{7,15}$'),
  constraint customer_sms_campaign_recipients_status_check
    check (status in ('queued', 'sending', 'sent', 'delivered', 'undelivered', 'failed', 'skipped')),
  constraint customer_sms_campaign_recipients_body_check
    check (length(btrim(body)) between 1 and 480),
  unique (campaign_id, phone_e164)
);

create index if not exists customer_sms_subscribers_status_idx
  on public.customer_sms_subscribers(status, opted_in_at desc);

create index if not exists customer_sms_subscribers_email_idx
  on public.customer_sms_subscribers(lower(email))
  where email is not null;

create index if not exists customer_sms_events_phone_idx
  on public.customer_sms_events(phone_e164, created_at desc);

create index if not exists customer_sms_events_type_idx
  on public.customer_sms_events(event_type, created_at desc);

create index if not exists customer_sms_campaigns_created_idx
  on public.customer_sms_campaigns(created_at desc);

create index if not exists customer_sms_campaign_recipients_campaign_idx
  on public.customer_sms_campaign_recipients(campaign_id, status);

create unique index if not exists customer_sms_campaign_recipients_sid_idx
  on public.customer_sms_campaign_recipients(provider_message_sid)
  where provider_message_sid is not null;

drop trigger if exists trg_customer_sms_subscribers_updated_at on public.customer_sms_subscribers;
create trigger trg_customer_sms_subscribers_updated_at
before update on public.customer_sms_subscribers
for each row execute function public.set_updated_at();

drop trigger if exists trg_customer_sms_campaigns_updated_at on public.customer_sms_campaigns;
create trigger trg_customer_sms_campaigns_updated_at
before update on public.customer_sms_campaigns
for each row execute function public.set_updated_at();

drop trigger if exists trg_customer_sms_campaign_recipients_updated_at on public.customer_sms_campaign_recipients;
create trigger trg_customer_sms_campaign_recipients_updated_at
before update on public.customer_sms_campaign_recipients
for each row execute function public.set_updated_at();

alter table public.customer_sms_subscribers enable row level security;
alter table public.customer_sms_events enable row level security;
alter table public.customer_sms_campaigns enable row level security;
alter table public.customer_sms_campaign_recipients enable row level security;

drop policy if exists "customer_sms_subscribers_admin_select" on public.customer_sms_subscribers;
create policy "customer_sms_subscribers_admin_select"
on public.customer_sms_subscribers
for select
to authenticated
using (public.is_admin());

drop policy if exists "customer_sms_events_admin_select" on public.customer_sms_events;
create policy "customer_sms_events_admin_select"
on public.customer_sms_events
for select
to authenticated
using (public.is_admin());

drop policy if exists "customer_sms_campaigns_admin_select" on public.customer_sms_campaigns;
create policy "customer_sms_campaigns_admin_select"
on public.customer_sms_campaigns
for select
to authenticated
using (public.is_admin());

drop policy if exists "customer_sms_campaign_recipients_admin_select" on public.customer_sms_campaign_recipients;
create policy "customer_sms_campaign_recipients_admin_select"
on public.customer_sms_campaign_recipients
for select
to authenticated
using (public.is_admin());

revoke all on public.customer_sms_subscribers from public, anon;
revoke all on public.customer_sms_events from public, anon;
revoke all on public.customer_sms_campaigns from public, anon;
revoke all on public.customer_sms_campaign_recipients from public, anon;

grant select on public.customer_sms_subscribers to authenticated;
grant select on public.customer_sms_events to authenticated;
grant select on public.customer_sms_campaigns to authenticated;
grant select on public.customer_sms_campaign_recipients to authenticated;

grant select, insert, update, delete on public.customer_sms_subscribers to service_role;
grant select, insert, update, delete on public.customer_sms_events to service_role;
grant select, insert, update, delete on public.customer_sms_campaigns to service_role;
grant select, insert, update, delete on public.customer_sms_campaign_recipients to service_role;

create or replace function public.customer_sms_record_opt_in(
  _phone_e164 text,
  _consent_source text default 'website',
  _consent_text text default null,
  _name text default null,
  _email text default null,
  _source text default null,
  _campaign text default null,
  _inbound_body text default null,
  _metadata jsonb default '{}'::jsonb
)
returns public.customer_sms_subscribers
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_phone text := nullif(btrim(coalesce(_phone_e164, '')), '');
  v_name text := nullif(btrim(coalesce(_name, '')), '');
  v_email text := lower(nullif(btrim(coalesce(_email, '')), ''));
  v_source text := nullif(btrim(coalesce(_source, '')), '');
  v_campaign text := nullif(btrim(coalesce(_campaign, '')), '');
  v_consent_source text := nullif(btrim(coalesce(_consent_source, '')), '');
  v_consent_text text := nullif(btrim(coalesce(_consent_text, '')), '');
  v_inbound_body text := nullif(btrim(coalesce(_inbound_body, '')), '');
  v_metadata jsonb := coalesce(_metadata, '{}'::jsonb);
  v_row public.customer_sms_subscribers;
begin
  if v_phone is null or v_phone !~ '^\+\d{7,15}$' then
    raise exception 'Phone must be a valid E.164 number';
  end if;

  if v_email is not null and v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Invalid email';
  end if;

  if v_consent_source is null then
    v_consent_source := 'website';
  end if;

  insert into public.customer_sms_subscribers (
    phone_e164,
    name,
    email,
    source,
    campaign,
    status,
    sms_consent,
    consent_source,
    consent_text,
    opted_in_at,
    opted_out_at,
    opt_out_source,
    last_inbound_body,
    last_inbound_at,
    metadata
  )
  values (
    v_phone,
    v_name,
    v_email,
    v_source,
    v_campaign,
    'subscribed',
    true,
    v_consent_source,
    v_consent_text,
    now(),
    null,
    null,
    v_inbound_body,
    case when v_inbound_body is null then null else now() end,
    v_metadata
  )
  on conflict (phone_e164)
  do update set
    name = coalesce(excluded.name, public.customer_sms_subscribers.name),
    email = coalesce(excluded.email, public.customer_sms_subscribers.email),
    source = coalesce(excluded.source, public.customer_sms_subscribers.source),
    campaign = coalesce(excluded.campaign, public.customer_sms_subscribers.campaign),
    status = 'subscribed',
    sms_consent = true,
    consent_source = excluded.consent_source,
    consent_text = excluded.consent_text,
    opted_in_at = now(),
    opted_out_at = null,
    opt_out_source = null,
    last_inbound_body = coalesce(excluded.last_inbound_body, public.customer_sms_subscribers.last_inbound_body),
    last_inbound_at = coalesce(excluded.last_inbound_at, public.customer_sms_subscribers.last_inbound_at),
    metadata = public.customer_sms_subscribers.metadata || excluded.metadata,
    updated_at = now()
  returning * into v_row;

  insert into public.customer_sms_events (
    subscriber_id,
    phone_e164,
    from_phone,
    to_phone,
    direction,
    event_type,
    body,
    raw_payload
  )
  values (
    v_row.id,
    v_row.phone_e164,
    v_row.phone_e164,
    v_metadata->>'to_phone',
    case when v_inbound_body is null then 'system' else 'inbound' end,
    case when v_inbound_body is null then 'website_opt_in' else 'subscribe' end,
    v_inbound_body,
    v_metadata
  );

  return v_row;
end;
$$;

create or replace function public.customer_sms_record_opt_out(
  _phone_e164 text,
  _opt_out_source text default 'inbound_sms',
  _inbound_body text default null,
  _metadata jsonb default '{}'::jsonb
)
returns public.customer_sms_subscribers
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_phone text := nullif(btrim(coalesce(_phone_e164, '')), '');
  v_source text := nullif(btrim(coalesce(_opt_out_source, '')), '');
  v_inbound_body text := nullif(btrim(coalesce(_inbound_body, '')), '');
  v_metadata jsonb := coalesce(_metadata, '{}'::jsonb);
  v_row public.customer_sms_subscribers;
begin
  if v_phone is null or v_phone !~ '^\+\d{7,15}$' then
    raise exception 'Phone must be a valid E.164 number';
  end if;

  if v_source is null then
    v_source := 'inbound_sms';
  end if;

  insert into public.customer_sms_subscribers (
    phone_e164,
    status,
    sms_consent,
    opted_in_at,
    opted_out_at,
    opt_out_source,
    last_inbound_body,
    last_inbound_at,
    metadata
  )
  values (
    v_phone,
    'unsubscribed',
    false,
    null,
    now(),
    v_source,
    v_inbound_body,
    case when v_inbound_body is null then null else now() end,
    v_metadata
  )
  on conflict (phone_e164)
  do update set
    status = 'unsubscribed',
    sms_consent = false,
    opted_out_at = now(),
    opt_out_source = excluded.opt_out_source,
    last_inbound_body = coalesce(excluded.last_inbound_body, public.customer_sms_subscribers.last_inbound_body),
    last_inbound_at = coalesce(excluded.last_inbound_at, public.customer_sms_subscribers.last_inbound_at),
    metadata = public.customer_sms_subscribers.metadata || excluded.metadata,
    updated_at = now()
  returning * into v_row;

  insert into public.customer_sms_events (
    subscriber_id,
    phone_e164,
    from_phone,
    to_phone,
    direction,
    event_type,
    body,
    raw_payload
  )
  values (
    v_row.id,
    v_row.phone_e164,
    v_row.phone_e164,
    v_metadata->>'to_phone',
    case when v_inbound_body is null then 'system' else 'inbound' end,
    'unsubscribe',
    v_inbound_body,
    v_metadata
  );

  return v_row;
end;
$$;

revoke all on function public.customer_sms_record_opt_in(text, text, text, text, text, text, text, text, jsonb)
from public, anon, authenticated;
revoke all on function public.customer_sms_record_opt_out(text, text, text, jsonb)
from public, anon, authenticated;

grant execute on function public.customer_sms_record_opt_in(text, text, text, text, text, text, text, text, jsonb)
to service_role;
grant execute on function public.customer_sms_record_opt_out(text, text, text, jsonb)
to service_role;

notify pgrst, 'reload schema';
