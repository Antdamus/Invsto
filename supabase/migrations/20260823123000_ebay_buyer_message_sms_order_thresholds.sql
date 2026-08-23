-- Add order-value urgency controls to eBay buyer-message SMS alerts.

alter table public.user_notification_preferences
  add column if not exists ebay_buyer_message_sms_min_order_total numeric(12,2),
  add column if not exists ebay_buyer_message_sms_max_order_total numeric(12,2);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.user_notification_preferences'::regclass
      and conname = 'user_notification_preferences_ebay_buyer_sms_min_check'
  ) then
    alter table public.user_notification_preferences
      add constraint user_notification_preferences_ebay_buyer_sms_min_check
      check (ebay_buyer_message_sms_min_order_total is null or ebay_buyer_message_sms_min_order_total >= 0)
      not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.user_notification_preferences'::regclass
      and conname = 'user_notification_preferences_ebay_buyer_sms_max_check'
  ) then
    alter table public.user_notification_preferences
      add constraint user_notification_preferences_ebay_buyer_sms_max_check
      check (ebay_buyer_message_sms_max_order_total is null or ebay_buyer_message_sms_max_order_total >= 0)
      not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.user_notification_preferences'::regclass
      and conname = 'user_notification_preferences_ebay_buyer_sms_range_check'
  ) then
    alter table public.user_notification_preferences
      add constraint user_notification_preferences_ebay_buyer_sms_range_check
      check (
        ebay_buyer_message_sms_min_order_total is null
        or ebay_buyer_message_sms_max_order_total is null
        or ebay_buyer_message_sms_min_order_total <= ebay_buyer_message_sms_max_order_total
      )
      not valid;
  end if;
end
$$;

alter table public.user_notification_preferences
  validate constraint user_notification_preferences_ebay_buyer_sms_min_check;

alter table public.user_notification_preferences
  validate constraint user_notification_preferences_ebay_buyer_sms_max_check;

alter table public.user_notification_preferences
  validate constraint user_notification_preferences_ebay_buyer_sms_range_check;

drop function if exists public.admin_upsert_ebay_buyer_message_sms_preference(uuid, boolean, text);

create or replace function public.admin_upsert_ebay_buyer_message_sms_preference(
  _user_id uuid,
  _enabled boolean default false,
  _app_base_url text default null,
  _min_order_total numeric default null,
  _max_order_total numeric default null
)
returns public.user_notification_preferences
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_url text := nullif(btrim(coalesce(_app_base_url, '')), '');
  v_min numeric(12,2) := case when _min_order_total is null then null else round(_min_order_total, 2) end;
  v_max numeric(12,2) := case when _max_order_total is null then null else round(_max_order_total, 2) end;
  v_row public.user_notification_preferences;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  if _user_id is null then
    raise exception 'User id is required';
  end if;

  if v_min is not null and v_min < 0 then
    raise exception 'Minimum order amount must be zero or greater';
  end if;

  if v_max is not null and v_max < 0 then
    raise exception 'Maximum order amount must be zero or greater';
  end if;

  if v_min is not null and v_max is not null and v_min > v_max then
    raise exception 'Minimum order amount cannot be higher than maximum order amount';
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
    ebay_buyer_message_sms_min_order_total,
    ebay_buyer_message_sms_max_order_total,
    updated_at,
    updated_by
  )
  values (
    _user_id,
    coalesce(_enabled, false),
    v_min,
    v_max,
    now(),
    auth.uid()
  )
  on conflict (user_id)
  do update set
    ebay_buyer_message_sms = excluded.ebay_buyer_message_sms,
    ebay_buyer_message_sms_min_order_total = excluded.ebay_buyer_message_sms_min_order_total,
    ebay_buyer_message_sms_max_order_total = excluded.ebay_buyer_message_sms_max_order_total,
    updated_at = now(),
    updated_by = auth.uid()
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.admin_upsert_ebay_buyer_message_sms_preference(uuid, boolean, text, numeric, numeric)
from public, anon;
grant execute on function public.admin_upsert_ebay_buyer_message_sms_preference(uuid, boolean, text, numeric, numeric)
to authenticated, service_role;

create or replace function public.get_ebay_buyer_message_sms_recipient_rules()
returns table(
  user_id uuid,
  recipient_email text,
  phone_e164 text,
  min_order_total numeric,
  max_order_total numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with eligible_users as (
    select distinct on (p.user_id)
      p.user_id,
      e.email as recipient_email,
      p.ebay_buyer_message_sms_min_order_total as min_order_total,
      p.ebay_buyer_message_sms_max_order_total as max_order_total
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
      public.get_task_notification_sms_phone(eu.user_id, eu.recipient_email) as phone_e164,
      eu.min_order_total,
      eu.max_order_total
    from eligible_users eu
  )
  select distinct on (r.phone_e164)
    r.user_id,
    r.recipient_email,
    r.phone_e164,
    r.min_order_total,
    r.max_order_total
  from recipients r
  where r.phone_e164 is not null
  order by r.phone_e164, r.user_id;
$$;

revoke all on function public.get_ebay_buyer_message_sms_recipient_rules()
from public, anon, authenticated;
grant execute on function public.get_ebay_buyer_message_sms_recipient_rules()
to service_role;

create or replace function public.format_ebay_buyer_message_sms(
  _buyer_username text,
  _message_preview text,
  _reply_url text default null,
  _order_total numeric default null,
  _order_numbers text[] default null
)
returns text
language sql
stable
as $$
  with parts as (
    select
      public.task_notification_brief_text(_buyer_username, 'buyer', 60) as buyer,
      public.task_notification_brief_text(_message_preview, 'New eBay message', 220) as preview,
      nullif(btrim(coalesce(_reply_url, '')), '') as reply_url,
      case
        when _order_total is not null
          then '$' || trim(to_char(_order_total, 'FM999,999,999,990.00')) || ' order'
        else 'order amount unknown'
      end as order_label,
      nullif(array_to_string(coalesce(_order_numbers, '{}'::text[]), ', '), '') as order_numbers
  )
  select left(
    regexp_replace(
      'OG eBay ' || order_label || ': ' || buyer || ' wrote: "' || preview || '".'
        || case when order_numbers is not null then ' Order: ' || order_numbers || '.' else '' end
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
  v_order_total numeric;
  v_order_numbers text[] := '{}'::text[];
  v_order_count integer := 0;
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

  with linked_order_ids as (
    select distinct l.ebay_order_id as order_id
    from public.ebay_conversation_links l
    where l.conversation_id = new.conversation_id
      and l.status in ('confirmed', 'suggested')
      and l.ebay_order_id is not null

    union

    select distinct line.order_id
    from public.ebay_conversation_links l
    join public.ebay_order_lines line on line.id = l.ebay_order_line_id
    where l.conversation_id = new.conversation_id
      and l.status in ('confirmed', 'suggested')
      and l.ebay_order_line_id is not null
      and line.order_id is not null
  ),
  linked_orders as (
    select distinct o.id, o.order_number, o.total_price
    from public.ebay_orders o
    join linked_order_ids ids on ids.order_id = o.id
  )
  select
    sum(o.total_price) filter (where o.total_price is not null),
    coalesce(
      array_agg(distinct o.order_number)
        filter (where nullif(btrim(o.order_number), '') is not null),
      '{}'::text[]
    ),
    count(*)
  into v_order_total, v_order_numbers, v_order_count
  from linked_orders o;

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
  v_body := public.format_ebay_buyer_message_sms(
    v_buyer_username,
    v_preview,
    v_reply_url,
    v_order_total,
    v_order_numbers
  );

  for v_recipient in
    select *
    from public.get_ebay_buyer_message_sms_recipient_rules()
  loop
    if (v_recipient.min_order_total is not null or v_recipient.max_order_total is not null)
      and v_order_total is null
    then
      continue;
    end if;

    if v_recipient.min_order_total is not null
      and v_order_total < v_recipient.min_order_total
    then
      continue;
    end if;

    if v_recipient.max_order_total is not null
      and v_order_total > v_recipient.max_order_total
    then
      continue;
    end if;

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
        'order_total', v_order_total,
        'order_numbers', to_jsonb(v_order_numbers),
        'order_count', v_order_count,
        'recipient_user_id', v_recipient.user_id,
        'recipient_min_order_total', v_recipient.min_order_total,
        'recipient_max_order_total', v_recipient.max_order_total,
        'reply_url', v_reply_url
      )
    )
    on conflict do nothing;
  end loop;

  return new;
end;
$$;
