-- Step 5F.6R.1 classification UX finalization.
-- Keeps unread transitions local to OG and prevents batch classification runs
-- from emitting one dashboard event per inserted classification row.

create or replace function public.mark_ebay_conversation_read(_conversation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_previous_unread integer := 0;
  v_messages_updated integer := 0;
begin
  if not public.is_admin() then
    raise exception 'Admin privileges are required to mark eBay conversations read'
      using errcode = '42501';
  end if;

  select coalesce(unread_count, 0)
    into v_previous_unread
  from public.ebay_conversations
  where id = _conversation_id;

  if not found then
    raise exception 'eBay conversation not found'
      using errcode = 'P0002';
  end if;

  update public.ebay_conversations
  set unread_count = 0
  where id = _conversation_id
    and unread_count <> 0;

  update public.ebay_conversation_messages
  set
    read_status = 'Read',
    is_read = true
  where conversation_id = _conversation_id
    and (
      is_read is distinct from true
      or coalesce(read_status, '') <> 'Read'
    );
  get diagnostics v_messages_updated = row_count;

  return jsonb_build_object(
    'ok', true,
    'conversation_id', _conversation_id,
    'previous_unread_count', v_previous_unread,
    'unread_count', 0,
    'messages_updated', v_messages_updated,
    'local_only', true
  );
end;
$$;

grant execute on function public.mark_ebay_conversation_read(uuid) to authenticated;

create or replace function public.log_ebay_classification_activity()
returns trigger
language plpgsql
as $$
begin
  if lower(coalesce(new.validation_metadata ->> 'suppress_activity_event', 'false')) in ('true', '1', 'yes') then
    return new;
  end if;

  perform public.record_ebay_message_activity_event(
    'conversation_classified',
    case when new.classification_status = 'failed' then 'failed' else 'succeeded' end,
    new.created_by,
    null,
    new.conversation_id,
    new.latest_message_id,
    null,
    null,
    null,
    new.id,
    null,
    null,
    'conversation_classified:' || new.id::text,
    'Conversation classified',
    coalesce(new.summary, new.recommended_action),
    jsonb_build_object(
      'priority', new.priority,
      'response_need', new.response_need,
      'topic_tags', new.topic_tags,
      'buyer_flags', new.buyer_flags,
      'risk_flags', new.risk_flags,
      'confidence', new.confidence,
      'classification_status', new.classification_status
    )
  );

  return new;
end;
$$;
