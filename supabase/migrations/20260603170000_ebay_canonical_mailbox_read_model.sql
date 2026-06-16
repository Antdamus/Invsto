-- Canonical eBay mailbox read model.
-- Read-only RPC for paginated archive search, exact smart-folder counts,
-- and canonical mailbox totals. This does not mutate eBay or local read state.

create or replace function public.get_ebay_canonical_mailbox(
  _page_size integer default 100,
  _offset integer default 0,
  _system_filter text default 'all',
  _search_terms text[] default '{}'::text[],
  _structured_filters jsonb default '{}'::jsonb,
  _classification_filters jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_page_size integer := least(greatest(coalesce(_page_size, 100), 1), 100);
  v_offset integer := greatest(coalesce(_offset, 0), 0);
  v_system_filter text := lower(coalesce(nullif(trim(_system_filter), ''), 'all'));
  v_search_terms text[] := '{}'::text[];
  v_filter_sources text[] := '{}'::text[];
  v_filter_topics text[] := '{}'::text[];
  v_filter_buyer_flags text[] := '{}'::text[];
  v_filter_risk_flags text[] := '{}'::text[];
  v_filter_priorities text[] := '{}'::text[];
  v_filter_response_needs text[] := '{}'::text[];
  v_structured_tags text[] := '{}'::text[];
  v_result jsonb;
begin
  if not public.can_manage_inventory() then
    raise exception 'not_authorized';
  end if;

  select coalesce(array_agg(distinct lower(trim(value))) filter (where trim(value) <> ''), '{}'::text[])
  into v_search_terms
  from unnest(coalesce(_search_terms, '{}'::text[])) as search_value(value);

  select coalesce(array_agg(distinct lower(trim(value))) filter (where trim(value) <> ''), '{}'::text[])
  into v_filter_sources
  from (
    select value from jsonb_array_elements_text(coalesce(_classification_filters -> 'sourceTypes', '[]'::jsonb)) as item(value)
    union all
    select value from jsonb_array_elements_text(coalesce(_structured_filters -> 'sourceTypes', '[]'::jsonb)) as item(value)
  ) source_values;

  select coalesce(array_agg(distinct lower(trim(value))) filter (where trim(value) <> ''), '{}'::text[])
  into v_filter_topics
  from (
    select value from jsonb_array_elements_text(coalesce(_classification_filters -> 'topics', '[]'::jsonb)) as item(value)
    union all
    select value from jsonb_array_elements_text(coalesce(_structured_filters -> 'topics', '[]'::jsonb)) as item(value)
  ) topic_values;

  select coalesce(array_agg(distinct lower(trim(value))) filter (where trim(value) <> ''), '{}'::text[])
  into v_filter_buyer_flags
  from (
    select value from jsonb_array_elements_text(coalesce(_classification_filters -> 'buyerFlags', '[]'::jsonb)) as item(value)
    union all
    select value from jsonb_array_elements_text(coalesce(_structured_filters -> 'buyerFlags', '[]'::jsonb)) as item(value)
  ) buyer_flag_values;

  select coalesce(array_agg(distinct lower(trim(value))) filter (where trim(value) <> ''), '{}'::text[])
  into v_filter_risk_flags
  from (
    select value from jsonb_array_elements_text(coalesce(_classification_filters -> 'riskFlags', '[]'::jsonb)) as item(value)
    union all
    select value from jsonb_array_elements_text(coalesce(_structured_filters -> 'riskFlags', '[]'::jsonb)) as item(value)
  ) risk_flag_values;

  select coalesce(array_agg(distinct lower(trim(value))) filter (where trim(value) <> ''), '{}'::text[])
  into v_filter_priorities
  from (
    select value from jsonb_array_elements_text(coalesce(_classification_filters -> 'priorities', '[]'::jsonb)) as item(value)
    union all
    select value from jsonb_array_elements_text(coalesce(_structured_filters -> 'priorities', '[]'::jsonb)) as item(value)
  ) priority_values;

  select coalesce(array_agg(distinct lower(trim(value))) filter (where trim(value) <> ''), '{}'::text[])
  into v_filter_response_needs
  from (
    select value from jsonb_array_elements_text(coalesce(_classification_filters -> 'responseNeeds', '[]'::jsonb)) as item(value)
    union all
    select value from jsonb_array_elements_text(coalesce(_structured_filters -> 'responseNeeds', '[]'::jsonb)) as item(value)
  ) response_need_values;

  select coalesce(array_agg(distinct lower(trim(value))) filter (where trim(value) <> ''), '{}'::text[])
  into v_structured_tags
  from jsonb_array_elements_text(coalesce(_structured_filters -> 'tags', '[]'::jsonb)) as tag_value(value);

  with base as materialized (
    select
      c.id,
      c.seller_account_id,
      c.ebay_conversation_id,
      c.conversation_type,
      c.conversation_status,
      c.conversation_title,
      c.other_party_username,
      c.reference_id,
      c.reference_type,
      c.unread_count,
      c.latest_message_id,
      c.latest_message_created_at,
      c.latest_message_preview,
      c.first_message_created_at,
      c.last_message_created_at,
      c.message_count,
      c.last_synced_at,
      c.last_detail_synced_at,
      c.updated_at,
      c.created_at,
      case when c.conversation_type = 'FROM_EBAY' then 'platform_notification' else 'member_message' end as derived_source,
      cc.id as classification_id,
      cc.latest_ebay_message_id,
      cc.priority,
      cc.response_need,
      coalesce(cc.topic_tags, '{}'::text[]) as topic_tags,
      coalesce(cc.buyer_flags, '{}'::text[]) as buyer_flags,
      coalesce(cc.risk_flags, '{}'::text[]) as risk_flags,
      cc.summary as classification_summary,
      cc.created_at as classification_created_at,
      coalesce(link_stats.link_count, 0) as link_count,
      coalesce(link_stats.suggested_link_count, 0) as suggested_link_count,
      coalesce(link_stats.has_order_link, false) as has_order_link,
      coalesce(link_stats.has_return_link, false) as has_return_link,
      coalesce(message_stats.has_media, false) as has_media,
      lower(concat_ws(
        ' ',
        c.ebay_conversation_id,
        c.conversation_type,
        c.conversation_status,
        c.conversation_title,
        c.other_party_username,
        c.reference_id,
        c.reference_type,
        c.latest_message_preview,
        case when c.conversation_type = 'FROM_EBAY' then 'platform_notification' else 'member_message' end,
        s.seller_username,
        cc.priority,
        cc.response_need,
        array_to_string(coalesce(cc.topic_tags, '{}'::text[]), ' '),
        array_to_string(coalesce(cc.buyer_flags, '{}'::text[]), ' '),
        array_to_string(coalesce(cc.risk_flags, '{}'::text[]), ' '),
        cc.summary,
        cc.reasoning_summary,
        cc.recommended_action,
        coalesce(link_stats.search_text, ''),
        coalesce(message_stats.search_text, '')
      )) as search_text
    from public.ebay_conversations c
    left join public.ebay_seller_accounts s on s.id = c.seller_account_id
    left join public.ebay_conversation_classifications cc
      on cc.conversation_id = c.id
      and cc.is_current = true
    left join lateral (
      select
        count(*) filter (where l.status in ('confirmed', 'suggested')) as link_count,
        count(*) filter (where l.status = 'suggested') as suggested_link_count,
        bool_or(l.status in ('confirmed', 'suggested') and l.link_type in ('ebay_order', 'ebay_order_line')) as has_order_link,
        bool_or(l.status in ('confirmed', 'suggested') and l.link_type = 'ebay_return_case') as has_return_link,
        string_agg(concat_ws(
          ' ',
          l.link_type,
          l.link_key,
          l.reference_id,
          l.reference_type,
          l.buyer_username,
          l.matched_value,
          l.metadata::text,
          o.order_number,
          o.buyer_username,
          o.buyer_name,
          o.buyer_email,
          ol.item_number,
          ol.transaction_id,
          ol.custom_label,
          ol.item_title,
          r.ebay_return_id,
          r.order_number,
          r.buyer_username,
          r.status
        ), ' ') as search_text
      from public.ebay_conversation_links l
      left join public.ebay_orders o on o.id = l.ebay_order_id
      left join public.ebay_order_lines ol on ol.id = l.ebay_order_line_id
      left join public.ebay_return_cases r on r.id = l.ebay_return_case_id
      where l.conversation_id = c.id
        and l.status in ('confirmed', 'suggested')
    ) link_stats on true
    left join lateral (
      select
        bool_or(m.has_media) as has_media,
        string_agg(concat_ws(
          ' ',
          m.ebay_message_id,
          m.sender_username,
          m.recipient_username,
          m.direction,
          m.subject,
          m.message_body_preview,
          m.message_body
        ), ' ') as search_text
      from public.ebay_conversation_messages m
      where m.conversation_id = c.id
    ) message_stats on true
  ),
  filtered as materialized (
    select *
    from base b
    where
      case v_system_filter
        when 'all' then true
        when 'members' then b.conversation_type = 'FROM_MEMBERS'
        when 'ebay_notifications' then b.conversation_type = 'FROM_EBAY'
        when 'unread' then b.unread_count > 0
        when 'returns' then b.has_return_link or b.topic_tags @> array['return']::text[]
        when 'shipping_issues' then b.topic_tags && array['shipping_issue', 'missing_item', 'order_status', 'delivery_timing']::text[]
        when 'needs_reply_today' then b.response_need = 'reply_today'
        when 'vip_buyers' then b.buyer_flags && array['vip_buyer']::text[]
        when 'high_value_buyers' then b.buyer_flags && array['high_value_buyer', 'high_retained_value_buyer']::text[]
        when 'refund_risk' then b.risk_flags && array['refund_risk', 'chargeback_risk', 'unsupported_claim_risk']::text[]
        when 'review_queue' then b.classification_id is null
          or b.link_count = 0
          or b.suggested_link_count > 0
          or (
            b.latest_message_id is not null
            and b.latest_ebay_message_id is not null
            and b.latest_message_id is distinct from b.latest_ebay_message_id
          )
          or (
            b.classification_created_at is not null
            and b.latest_message_created_at is not null
            and b.latest_message_created_at > b.classification_created_at + interval '1 second'
          )
          or b.risk_flags && array['context_review_needed', 'low_confidence']::text[]
        when 'has_order' then b.has_order_link
        when 'has_return' then b.has_return_link
        when 'has_media' then b.has_media
        when 'needs_context_review' then b.link_count = 0 or b.suggested_link_count > 0
        else true
      end
      and (
        cardinality(v_filter_sources) = 0
        or (cardinality(v_filter_sources) = 1 and b.derived_source = v_filter_sources[1])
      )
      and (cardinality(v_filter_topics) = 0 or b.topic_tags @> v_filter_topics)
      and (cardinality(v_filter_buyer_flags) = 0 or b.buyer_flags @> v_filter_buyer_flags)
      and (cardinality(v_filter_risk_flags) = 0 or b.risk_flags @> v_filter_risk_flags)
      and (cardinality(v_filter_priorities) = 0 or (b.priority is not null and array[b.priority]::text[] @> v_filter_priorities))
      and (cardinality(v_filter_response_needs) = 0 or (b.response_need is not null and array[b.response_need]::text[] @> v_filter_response_needs))
      and (
        cardinality(v_structured_tags) = 0
        or not exists (
          select 1
          from unnest(v_structured_tags) as tag(value)
          where not (
            tag.value = b.derived_source
            or tag.value = b.priority
            or tag.value = b.response_need
            or tag.value = any(b.topic_tags)
            or tag.value = any(b.buyer_flags)
            or tag.value = any(b.risk_flags)
          )
        )
      )
      and (
        cardinality(v_search_terms) = 0
        or not exists (
          select 1
          from unnest(v_search_terms) as term(value)
          where b.search_text not like '%' || term.value || '%'
        )
      )
  ),
  page_rows as (
    select
      id,
      seller_account_id,
      ebay_conversation_id,
      conversation_type,
      conversation_status,
      conversation_title,
      other_party_username,
      reference_id,
      reference_type,
      unread_count,
      latest_message_id,
      latest_message_created_at,
      latest_message_preview,
      first_message_created_at,
      last_message_created_at,
      message_count,
      last_synced_at,
      last_detail_synced_at,
      updated_at,
      created_at
    from filtered
    order by latest_message_created_at desc nulls last, updated_at desc nulls last, id desc
    offset v_offset
    limit v_page_size
  ),
  totals as (
    select
      (select count(*) from base) as canonical_total,
      (select count(*) from filtered) as matching_total,
      (select count(*) from page_rows) as loaded_count
  ),
  smart_counts as (
    select jsonb_build_object(
      'all', count(*),
      'members', count(*) filter (where conversation_type = 'FROM_MEMBERS'),
      'ebay_notifications', count(*) filter (where conversation_type = 'FROM_EBAY'),
      'unread', count(*) filter (where unread_count > 0),
      'returns', count(*) filter (where has_return_link or topic_tags @> array['return']::text[]),
      'shipping_issues', count(*) filter (where topic_tags && array['shipping_issue', 'missing_item', 'order_status', 'delivery_timing']::text[]),
      'needs_reply_today', count(*) filter (where response_need = 'reply_today'),
      'vip_buyers', count(*) filter (where buyer_flags && array['vip_buyer']::text[]),
      'high_value_buyers', count(*) filter (where buyer_flags && array['high_value_buyer', 'high_retained_value_buyer']::text[]),
      'refund_risk', count(*) filter (where risk_flags && array['refund_risk', 'chargeback_risk', 'unsupported_claim_risk']::text[]),
      'review_queue', count(*) filter (
        where classification_id is null
          or link_count = 0
          or suggested_link_count > 0
          or (
            latest_message_id is not null
            and latest_ebay_message_id is not null
            and latest_message_id is distinct from latest_ebay_message_id
          )
          or (
            classification_created_at is not null
            and latest_message_created_at is not null
            and latest_message_created_at > classification_created_at + interval '1 second'
          )
          or risk_flags && array['context_review_needed', 'low_confidence']::text[]
      ),
      'has_order', count(*) filter (where has_order_link),
      'has_return', count(*) filter (where has_return_link),
      'has_media', count(*) filter (where has_media),
      'needs_context_review', count(*) filter (where link_count = 0 or suggested_link_count > 0)
    ) as counts
    from base
  ),
  option_counts as (
    select jsonb_build_object(
      'sourceTypes', jsonb_build_object(
        'member_message', count(*) filter (where derived_source = 'member_message'),
        'platform_notification', count(*) filter (where derived_source = 'platform_notification')
      ),
      'topics', coalesce((select jsonb_object_agg(value, row_count) from (select value, count(*) as row_count from base, unnest(topic_tags) as topic(value) group by value) rows), '{}'::jsonb),
      'buyerFlags', coalesce((select jsonb_object_agg(value, row_count) from (select value, count(*) as row_count from base, unnest(buyer_flags) as buyer_flag(value) group by value) rows), '{}'::jsonb),
      'riskFlags', coalesce((select jsonb_object_agg(value, row_count) from (select value, count(*) as row_count from base, unnest(risk_flags) as risk_flag(value) group by value) rows), '{}'::jsonb),
      'priorities', coalesce((select jsonb_object_agg(priority, row_count) from (select priority, count(*) as row_count from base where priority is not null group by priority) rows), '{}'::jsonb),
      'responseNeeds', coalesce((select jsonb_object_agg(response_need, row_count) from (select response_need, count(*) as row_count from base where response_need is not null group by response_need) rows), '{}'::jsonb)
    ) as counts
  )
  select jsonb_build_object(
    'ok', true,
    'canonical_total', totals.canonical_total,
    'matching_total', totals.matching_total,
    'loaded_count', totals.loaded_count,
    'page_size', v_page_size,
    'offset', v_offset,
    'next_offset', case when v_offset + totals.loaded_count < totals.matching_total then v_offset + totals.loaded_count else null end,
    'has_more', v_offset + totals.loaded_count < totals.matching_total,
    'system_filter', v_system_filter,
    'search_terms', to_jsonb(v_search_terms),
    'structured_filters', coalesce(_structured_filters, '{}'::jsonb),
    'classification_filters', coalesce(_classification_filters, '{}'::jsonb),
    'smart_folder_counts', smart_counts.counts,
    'filter_option_counts', option_counts.counts,
    'conversations', coalesce((select jsonb_agg(to_jsonb(page_rows) order by latest_message_created_at desc nulls last, updated_at desc nulls last, id desc) from page_rows), '[]'::jsonb),
    'loaded_at', now()
  )
  into v_result
  from totals, smart_counts, option_counts;

  return v_result;
end;
$$;

revoke all on function public.get_ebay_canonical_mailbox(integer, integer, text, text[], jsonb, jsonb) from public, anon;
grant execute on function public.get_ebay_canonical_mailbox(integer, integer, text, text[], jsonb, jsonb) to authenticated;
