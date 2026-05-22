-- Lightweight return-message audit trail for messages sent through eBay pages.
-- This does not send messages through eBay; it records what the seller typed
-- on the eBay return message page so OG keeps the conversation context.

create table if not exists public.ebay_return_messages (
  id uuid primary key default gen_random_uuid(),
  return_case_id uuid references public.ebay_return_cases(id) on delete set null,
  order_id uuid references public.ebay_orders(id) on delete set null,
  order_number text,
  ebay_return_id text,
  buyer_username text,
  direction text not null default 'outbound'
    check (direction in ('outbound', 'inbound', 'internal')),
  channel text not null default 'ebay_return_message_page',
  message_status text not null default 'sent_from_ebay_page_unverified'
    check (message_status in ('draft', 'sent_from_ebay_page_unverified', 'sent', 'imported', 'failed')),
  message_body text not null,
  item_title text,
  return_reason text,
  request_amount text,
  page_url text,
  sent_at timestamptz not null default now(),
  logged_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  created_by_email text,
  metadata jsonb not null default '{}'::jsonb
);

alter table public.ebay_return_messages enable row level security;

drop policy if exists "ebay_return_messages_inventory_staff_select" on public.ebay_return_messages;
create policy "ebay_return_messages_inventory_staff_select"
on public.ebay_return_messages
for select
to authenticated
using (public.can_manage_inventory());

drop policy if exists "ebay_return_messages_inventory_staff_insert" on public.ebay_return_messages;
create policy "ebay_return_messages_inventory_staff_insert"
on public.ebay_return_messages
for insert
to authenticated
with check (public.can_manage_inventory());

grant select, insert on table public.ebay_return_messages to authenticated;

create index if not exists ebay_return_messages_case_idx
  on public.ebay_return_messages(return_case_id, logged_at desc);

create index if not exists ebay_return_messages_return_id_idx
  on public.ebay_return_messages(ebay_return_id, logged_at desc);

create index if not exists ebay_return_messages_order_idx
  on public.ebay_return_messages(order_number, logged_at desc);

create or replace function public.record_ebay_return_message_log(
  _payload jsonb,
  _signed_by_email text default null
)
returns public.ebay_return_messages
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payload jsonb := case
    when jsonb_typeof(coalesce(_payload, '{}'::jsonb)) = 'object'
      then coalesce(_payload, '{}'::jsonb)
    else jsonb_build_object('payload', _payload)
  end;
  v_case public.ebay_return_cases;
  v_order public.ebay_orders;
  v_task public.ebay_return_tasks;
  v_message public.ebay_return_messages;
  v_return_id text := nullif(btrim(coalesce(v_payload->>'returnId', v_payload->>'ebayReturnId', '')), '');
  v_order_number text := nullif(btrim(coalesce(v_payload->>'orderNumber', v_payload->>'orderId', '')), '');
  v_buyer text := nullif(btrim(coalesce(v_payload->>'buyerUsername', v_payload->>'buyer', '')), '');
  v_body text := nullif(btrim(coalesce(v_payload->>'messageBody', v_payload->>'message', '')), '');
  v_direction text := coalesce(nullif(btrim(coalesce(v_payload->>'direction', '')), ''), 'outbound');
  v_status text := coalesce(nullif(btrim(coalesce(v_payload->>'messageStatus', '')), ''), 'sent_from_ebay_page_unverified');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to record eBay return messages' using errcode = '42501';
  end if;

  if v_body is null then
    raise exception 'Message body is required' using errcode = '22023';
  end if;

  if v_direction not in ('outbound', 'inbound', 'internal') then
    raise exception 'Invalid eBay return message direction: %', v_direction using errcode = '22023';
  end if;

  if v_status not in ('draft', 'sent_from_ebay_page_unverified', 'sent', 'imported', 'failed') then
    raise exception 'Invalid eBay return message status: %', v_status using errcode = '22023';
  end if;

  select *
    into v_case
  from public.ebay_return_cases c
  where (v_return_id is not null and c.ebay_return_id = v_return_id)
     or (
       v_return_id is null
       and v_order_number is not null
       and c.order_number = v_order_number
       and (v_buyer is null or lower(coalesce(c.buyer_username, '')) = lower(v_buyer))
     )
  order by c.opened_at desc
  limit 1;

  if v_order_number is not null then
    select *
      into v_order
    from public.ebay_orders
    where order_number = v_order_number
    order by created_at desc
    limit 1;
  end if;

  insert into public.ebay_return_messages (
    return_case_id,
    order_id,
    order_number,
    ebay_return_id,
    buyer_username,
    direction,
    channel,
    message_status,
    message_body,
    item_title,
    return_reason,
    request_amount,
    page_url,
    sent_at,
    created_by,
    created_by_email,
    metadata
  )
  values (
    v_case.id,
    coalesce(v_case.order_id, v_order.id),
    coalesce(v_case.order_number, v_order_number),
    coalesce(v_case.ebay_return_id, v_return_id),
    coalesce(v_case.buyer_username, v_buyer),
    v_direction,
    coalesce(nullif(btrim(coalesce(v_payload->>'channel', '')), ''), 'ebay_return_message_page'),
    v_status,
    v_body,
    nullif(btrim(coalesce(v_payload->>'itemTitle', '')), ''),
    nullif(btrim(coalesce(v_payload->>'returnReason', '')), ''),
    nullif(btrim(coalesce(v_payload->>'requestAmount', '')), ''),
    nullif(btrim(coalesce(v_payload->>'pageUrl', '')), ''),
    coalesce(nullif(v_payload->>'sentAt', '')::timestamptz, now()),
    auth.uid(),
    v_signed_email,
    v_payload
  )
  returning * into v_message;

  if v_case.id is not null then
    select *
      into v_task
    from public.ebay_return_tasks
    where return_case_id = v_case.id
    order by
      case when status not in ('resolved', 'cancelled') then 0 else 1 end,
      created_at desc
    limit 1;

    if found then
      insert into public.ebay_return_task_events (
        task_id,
        return_case_id,
        action,
        old_status,
        new_status,
        notes,
        signed_by,
        signed_by_email,
        payload
      )
      values (
        v_task.id,
        v_case.id,
        'commented',
        v_task.status,
        v_task.status,
        'Logged outbound eBay buyer message.',
        auth.uid(),
        v_signed_email,
        jsonb_build_object(
          'source', 'ebay_return_message_page',
          'return_message_id', v_message.id,
          'direction', v_message.direction,
          'message_status', v_message.message_status
        )
      );
    end if;
  end if;

  return v_message;
end;
$$;

grant execute on function public.record_ebay_return_message_log(jsonb, text) to authenticated;
