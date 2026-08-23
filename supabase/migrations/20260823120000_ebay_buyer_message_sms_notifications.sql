-- Queue SMS alerts for new inbound eBay buyer messages.
-- Recipients are controlled per user from the admin dashboard.

alter table public.user_notification_preferences
  add column if not exists ebay_buyer_message_sms boolean not null default false;

create index if not exists user_notification_preferences_ebay_buyer_sms_idx
  on public.user_notification_preferences(ebay_buyer_message_sms)
  where ebay_buyer_message_sms is true;

create table if not exists public.ebay_buyer_message_sms_settings (
  id boolean primary key default true check (id),
  app_base_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  constraint ebay_buyer_message_sms_settings_base_url_check
    check (app_base_url is null or app_base_url ~* '^https?://')
);

insert into public.ebay_buyer_message_sms_settings (id)
values (true)
on conflict (id) do nothing;

alter table public.ebay_buyer_message_sms_settings enable row level security;

drop policy if exists "ebay_buyer_message_sms_settings_admin_all"
on public.ebay_buyer_message_sms_settings;
create policy "ebay_buyer_message_sms_settings_admin_all"
on public.ebay_buyer_message_sms_settings
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

grant select, insert, update on public.ebay_buyer_message_sms_settings to authenticated;
grant select, insert, update, delete on public.ebay_buyer_message_sms_settings to service_role;

create unique index if not exists sms_outbox_ebay_buyer_message_once_idx
  on public.sms_outbox (to_phone, ((meta->>'message_id')))
  where (meta->>'type') = 'ebay_buyer_message'
    and meta ? 'message_id';

create or replace function public.admin_upsert_ebay_buyer_message_sms_preference(
  _user_id uuid,
  _enabled boolean default false,
  _app_base_url text default null
)
returns public.user_notification_preferences
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_url text := nullif(btrim(coalesce(_app_base_url, '')), '');
  v_row public.user_notification_preferences;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  if _user_id is null then
    raise exception 'User id is required';
  end if;

  if v_url is not null then
    v_url := regexp_replace(v_url, '/+$', '');

    if v_url !~* '^https?://' then
      raise exception 'App base URL must start with http:// or https://';
    end if;

    insert into public.ebay_buyer_message_sms_settings (
      id,
      app_base_url,
      updated_at,
      updated_by
    )
    values (
      true,
      v_url,
      now(),
      auth.uid()
    )
    on conflict (id)
    do update set
      app_base_url = excluded.app_base_url,
      updated_at = now(),
      updated_by = auth.uid();
  end if;

  insert into public.user_notification_preferences (
    user_id,
    ebay_buyer_message_sms,
    updated_at,
    updated_by
  )
  values (
    _user_id,
    coalesce(_enabled, false),
    now(),
    auth.uid()
  )
  on conflict (user_id)
  do update set
    ebay_buyer_message_sms = excluded.ebay_buyer_message_sms,
    updated_at = now(),
    updated_by = auth.uid()
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.admin_upsert_ebay_buyer_message_sms_preference(uuid, boolean, text)
from public, anon;
grant execute on function public.admin_upsert_ebay_buyer_message_sms_preference(uuid, boolean, text)
to authenticated, service_role;

create or replace function public.get_ebay_buyer_message_sms_recipients()
returns table(user_id uuid, recipient_email text, phone_e164 text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with eligible_users as (
    select distinct on (p.user_id)
      p.user_id,
      e.email as recipient_email
    from public.user_notification_preferences p
    join public.employees e on e.user_id = p.user_id
    where p.ebay_buyer_message_sms is true
      and e.active is true
      and (
        e.email_triage_access is true
        or lower(coalesce(e.role, '')) = 'admin'
      )
    order by p.user_id, e.created_at desc nulls last
  ),
  recipients as (
    select
      eu.user_id,
      eu.recipient_email,
      public.get_task_notification_sms_phone(eu.user_id, eu.recipient_email) as phone_e164
    from eligible_users eu
  )
  select distinct on (r.phone_e164)
    r.user_id,
    r.recipient_email,
    r.phone_e164
  from recipients r
  where r.phone_e164 is not null
  order by r.phone_e164, r.user_id;
$$;

revoke all on function public.get_ebay_buyer_message_sms_recipients()
from public, anon, authenticated;
grant execute on function public.get_ebay_buyer_message_sms_recipients()
to service_role;

create or replace function public.format_ebay_buyer_message_sms(
  _buyer_username text,
  _message_preview text,
  _reply_url text default null
)
returns text
language sql
stable
as $$
  with parts as (
    select
      public.task_notification_brief_text(_buyer_username, 'buyer', 60) as buyer,
      public.task_notification_brief_text(_message_preview, 'New eBay message', 220) as preview,
      nullif(btrim(coalesce(_reply_url, '')), '') as reply_url
  )
  select left(
    regexp_replace(
      'OG eBay: ' || buyer || ' wrote: "' || preview || '".'
        || case
          when reply_url is not null then ' Reply: ' || reply_url
          else ' Open Email Triage to reply.'
        end,
      '\s+',
      ' ',
      'g'
    ),
    480
  )
  from parts;
$$;

create or replace function public.enqueue_ebay_buyer_message_sms()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_base_url text;
  v_reply_url text;
  v_buyer_username text;
  v_preview text;
  v_body text;
  v_recipient record;
begin
  if lower(coalesce(new.direction, '')) <> 'inbound' then
    return new;
  end if;

  if coalesce(new.conversation_type, '') <> 'FROM_MEMBERS' then
    return new;
  end if;

  if new.is_read is true or lower(coalesce(new.read_status, '')) = 'read' then
    return new;
  end if;

  if new.created_at_ebay is not null
    and new.created_at_ebay < now() - interval '12 hours'
  then
    return new;
  end if;

  select nullif(btrim(regexp_replace(coalesce(s.app_base_url, ''), '/+$', '')), '')
  into v_base_url
  from public.ebay_buyer_message_sms_settings s
  where s.id is true;

  if v_base_url is not null then
    v_reply_url := v_base_url
      || '/email-triage.html?ebayConversationDbId='
      || new.conversation_id::text
      || '&ebayMessageDbId='
      || new.id::text;
  end if;

  select coalesce(
    nullif(btrim(new.sender_username), ''),
    nullif(btrim(c.other_party_username), ''),
    'buyer'
  )
  into v_buyer_username
  from public.ebay_conversations c
  where c.id = new.conversation_id;

  v_buyer_username := coalesce(nullif(v_buyer_username, ''), 'buyer');
  v_preview := coalesce(
    nullif(btrim(new.message_body_preview), ''),
    nullif(btrim(new.message_body), ''),
    nullif(btrim(new.subject), ''),
    'New eBay message'
  );
  v_body := public.format_ebay_buyer_message_sms(v_buyer_username, v_preview, v_reply_url);

  for v_recipient in
    select *
    from public.get_ebay_buyer_message_sms_recipients()
  loop
    insert into public.sms_outbox (
      to_phone,
      body,
      send_after,
      meta
    )
    values (
      v_recipient.phone_e164,
      v_body,
      now(),
      jsonb_build_object(
        'type', 'ebay_buyer_message',
        'message_id', new.id,
        'conversation_id', new.conversation_id,
        'seller_account_id', new.seller_account_id,
        'ebay_conversation_id', new.ebay_conversation_id,
        'conversation_type', new.conversation_type,
        'ebay_message_id', new.ebay_message_id,
        'buyer_username', v_buyer_username,
        'recipient_user_id', v_recipient.user_id,
        'reply_url', v_reply_url
      )
    )
    on conflict do nothing;
  end loop;

  return new;
end;
$$;

drop trigger if exists trg_enqueue_ebay_buyer_message_sms
on public.ebay_conversation_messages;
create trigger trg_enqueue_ebay_buyer_message_sms
after insert on public.ebay_conversation_messages
for each row
execute function public.enqueue_ebay_buyer_message_sms();
