-- Queue buyer-message SMS after conversation context linking, so order totals are available.

drop trigger if exists trg_enqueue_ebay_buyer_message_sms
on public.ebay_conversation_messages;

create or replace function public.enqueue_ebay_buyer_message_sms_for_conversation(
  _conversation_id uuid,
  _message_ids uuid[] default null
)
returns integer
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
  v_message record;
  v_recipient record;
  v_inserted integer := 0;
  v_inserted_this integer := 0;
begin
  if _conversation_id is null then
    return 0;
  end if;

  with linked_order_ids as (
    select distinct l.ebay_order_id as order_id
    from public.ebay_conversation_links l
    where l.conversation_id = _conversation_id
      and l.status in ('confirmed', 'suggested')
      and l.ebay_order_id is not null

    union

    select distinct line.order_id
    from public.ebay_conversation_links l
    join public.ebay_order_lines line on line.id = l.ebay_order_line_id
    where l.conversation_id = _conversation_id
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

  for v_message in
    select m.*
    from public.ebay_conversation_messages m
    where m.conversation_id = _conversation_id
      and (
        cardinality(coalesce(_message_ids, '{}'::uuid[])) = 0
        or m.id = any(_message_ids)
      )
      and lower(coalesce(m.direction, '')) = 'inbound'
      and coalesce(m.conversation_type, '') = 'FROM_MEMBERS'
      and not (m.is_read is true or lower(coalesce(m.read_status, '')) = 'read')
      and (
        m.created_at_ebay is null
        or m.created_at_ebay >= now() - interval '12 hours'
      )
    order by m.created_at_ebay desc nulls last, m.created_at desc
  loop
    if v_base_url is not null then
      v_reply_url := v_base_url
        || '/email-triage.html?ebayConversationDbId='
        || v_message.conversation_id::text
        || '&ebayMessageDbId='
        || v_message.id::text;
    else
      v_reply_url := null;
    end if;

    select coalesce(
      nullif(btrim(v_message.sender_username), ''),
      nullif(btrim(c.other_party_username), ''),
      'buyer'
    )
    into v_buyer_username
    from public.ebay_conversations c
    where c.id = v_message.conversation_id;

    v_buyer_username := coalesce(nullif(v_buyer_username, ''), 'buyer');
    v_preview := coalesce(
      nullif(btrim(v_message.message_body_preview), ''),
      nullif(btrim(v_message.message_body), ''),
      nullif(btrim(v_message.subject), ''),
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
          'message_id', v_message.id,
          'conversation_id', v_message.conversation_id,
          'seller_account_id', v_message.seller_account_id,
          'ebay_conversation_id', v_message.ebay_conversation_id,
          'conversation_type', v_message.conversation_type,
          'ebay_message_id', v_message.ebay_message_id,
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

      get diagnostics v_inserted_this = row_count;
      v_inserted := v_inserted + v_inserted_this;
    end loop;
  end loop;

  return v_inserted;
end;
$$;

revoke all on function public.enqueue_ebay_buyer_message_sms_for_conversation(uuid, uuid[])
from public, anon, authenticated;
grant execute on function public.enqueue_ebay_buyer_message_sms_for_conversation(uuid, uuid[])
to service_role;
