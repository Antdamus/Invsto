-- Step 5F.6P provider-aware canonical eBay mailbox read model.
-- Replaces the v2 RPC so the mailbox row payload includes provider/local
-- read state without changing filters, send behavior, or eBay mutations.

create or replace function public.get_ebay_canonical_mailbox_v2(
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
  v_structured_filters jsonb := '{}'::jsonb;
  v_classification_filters jsonb := '{}'::jsonb;
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

  if v_system_filter = 'shipping' then
    v_system_filter := 'shipping_issues';
  end if;

  v_structured_filters := case
    when jsonb_typeof(coalesce(_structured_filters, '{}'::jsonb)) = 'object' then coalesce(_structured_filters, '{}'::jsonb)
    else '{}'::jsonb
  end;

  v_classification_filters := case
    when jsonb_typeof(coalesce(_classification_filters, '{}'::jsonb)) = 'object' then coalesce(_classification_filters, '{}'::jsonb)
    else '{}'::jsonb
  end;

  select coalesce(array_agg(distinct lower(trim(value))) filter (where trim(value) <> ''), '{}'::text[])
  into v_search_terms
  from unnest(coalesce(_search_terms, '{}'::text[])) as search_value(value);

  select coalesce(array_agg(distinct lower(trim(value))) filter (where trim(value) <> ''), '{}'::text[])
  into v_filter_sources
  from (
    select value
    from jsonb_array_elements_text(case when jsonb_typeof(v_classification_filters -> 'sourceTypes') = 'array' then v_classification_filters -> 'sourceTypes' else '[]'::jsonb end) as item(value)
    union all
    select value
    from jsonb_array_elements_text(case when jsonb_typeof(v_structured_filters -> 'sourceTypes') = 'array' then v_structured_filters -> 'sourceTypes' else '[]'::jsonb end) as item(value)
  ) source_values;

  select coalesce(array_agg(distinct lower(trim(value))) filter (where trim(value) <> ''), '{}'::text[])
  into v_filter_topics
  from (
    select value
    from jsonb_array_elements_text(case when jsonb_typeof(v_classification_filters -> 'topics') = 'array' then v_classification_filters -> 'topics' else '[]'::jsonb end) as item(value)
    union all
    select value
    from jsonb_array_elements_text(case when jsonb_typeof(v_structured_filters -> 'topics') = 'array' then v_structured_filters -> 'topics' else '[]'::jsonb end) as item(value)
  ) topic_values;

  select coalesce(array_agg(distinct lower(trim(value))) filter (where trim(value) <> ''), '{}'::text[])
  into v_filter_buyer_flags
  from (
    select value
    from jsonb_array_elements_text(case when jsonb_typeof(v_classification_filters -> 'buyerFlags') = 'array' then v_classification_filters -> 'buyerFlags' else '[]'::jsonb end) as item(value)
    union all
    select value
    from jsonb_array_elements_text(case when jsonb_typeof(v_structured_filters -> 'buyerFlags') = 'array' then v_structured_filters -> 'buyerFlags' else '[]'::jsonb end) as item(value)
  ) buyer_flag_values;

  select coalesce(array_agg(distinct lower(trim(value))) filter (where trim(value) <> ''), '{}'::text[])
  into v_filter_risk_flags
  from (
    select value
    from jsonb_array_elements_text(case when jsonb_typeof(v_classification_filters -> 'riskFlags') = 'array' then v_classification_filters -> 'riskFlags' else '[]'::jsonb end) as item(value)
    union all
    select value
    from jsonb_array_elements_text(case when jsonb_typeof(v_structured_filters -> 'riskFlags') = 'array' then v_structured_filters -> 'riskFlags' else '[]'::jsonb end) as item(value)
  ) risk_flag_values;

  select coalesce(array_agg(distinct lower(trim(value))) filter (where trim(value) <> ''), '{}'::text[])
  into v_filter_priorities
  from (
    select value
    from jsonb_array_elements_text(case when jsonb_typeof(v_classification_filters -> 'priorities') = 'array' then v_classification_filters -> 'priorities' else '[]'::jsonb end) as item(value)
    union all
    select value
    from jsonb_array_elements_text(case when jsonb_typeof(v_structured_filters -> 'priorities') = 'array' then v_structured_filters -> 'priorities' else '[]'::jsonb end) as item(value)
  ) priority_values;

  select coalesce(array_agg(distinct lower(trim(value))) filter (where trim(value) <> ''), '{}'::text[])
  into v_filter_response_needs
  from (
    select value
    from jsonb_array_elements_text(case when jsonb_typeof(v_classification_filters -> 'responseNeeds') = 'array' then v_classification_filters -> 'responseNeeds' else '[]'::jsonb end) as item(value)
    union all
    select value
    from jsonb_array_elements_text(case when jsonb_typeof(v_structured_filters -> 'responseNeeds') = 'array' then v_structured_filters -> 'responseNeeds' else '[]'::jsonb end) as item(value)
  ) response_need_values;

  select coalesce(array_agg(distinct lower(trim(value))) filter (where trim(value) <> ''), '{}'::text[])
  into v_structured_tags
  from jsonb_array_elements_text(case when jsonb_typeof(v_structured_filters -> 'tags') = 'array' then v_structured_filters -> 'tags' else '[]'::jsonb end) as tag_value(value);

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
      c.provider_read_state,
      c.local_read_state,
      c.pending_provider_update,
      c.last_provider_seen_at,
      c.last_local_read_at,
      c.last_read_sync_at,
      c.read_sync_status,
      c.read_sync_error,
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
      s.seller_username,
      case when c.conversation_type = 'FROM_EBAY' then 'platform_notification' else 'member_message' end as derived_source,
      cc.id as classification_id,
      cc.latest_message_id as classification_latest_message_id,
      cc.latest_ebay_message_id as classification_latest_ebay_message_id,
      cc.conversation_source as classification_conversation_source,
      cc.classification_status,
      cc.priority,
      cc.response_need,
      coalesce(cc.topic_tags, '{}'::text[]) as topic_tags,
      coalesce(cc.buyer_flags, '{}'::text[]) as buyer_flags,
      coalesce(cc.risk_flags, '{}'::text[]) as risk_flags,
      cc.confidence,
      cc.summary as classification_summary,
      cc.reasoning_summary,
      cc.recommended_action,
      cc.input_hash,
      cc.context_hash,
      cc.classifier_name,
      cc.classifier_version,
      cc.prompt_version,
      cc.model_name,
      cc.review_state,
      cc.operator_override_payload,
      cc.operator_notes,
      cc.reviewed_by,
      cc.reviewed_at,
      cc.created_at as classification_created_at,
      cc.updated_at as classification_updated_at,
      coalesce(link_stats.link_count, 0) as link_count,
      coalesce(link_stats.suggested_link_count, 0) as suggested_link_count,
      coalesce(link_stats.has_order_link, false) as has_order_link,
      coalesce(link_stats.has_return_link, false) as has_return_link,
      coalesce(link_stats.link_rows, '[]'::jsonb) as link_rows,
      coalesce(message_stats.message_row_count, 0) as message_row_count,
      coalesce(message_stats.has_media, false) as has_media,
      coalesce(message_stats.media_count, 0) as media_count,
      coalesce(message_stats.latest_message_preview, c.latest_message_preview, '') as effective_latest_message_preview,
      lower(concat_ws(
        ' ',
        c.id::text,
        c.seller_account_id::text,
        c.ebay_conversation_id,
        c.conversation_type,
        c.conversation_status,
        c.conversation_title,
        c.other_party_username,
        c.reference_id,
        c.reference_type,
        c.latest_message_id,
        c.latest_message_preview,
        s.seller_username,
        case when c.conversation_type = 'FROM_EBAY' then 'platform_notification' else 'member_message' end,
        cc.conversation_source,
        cc.classification_status,
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
        jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
          'id', l.id,
          'link_type', l.link_type,
          'link_key', l.link_key,
          'status', l.status,
          'confidence', l.confidence,
          'reference_id', l.reference_id,
          'reference_type', l.reference_type,
          'buyer_username', l.buyer_username,
          'matched_value', l.matched_value,
          'ebay_order_id', l.ebay_order_id,
          'ebay_order_line_id', l.ebay_order_line_id,
          'ebay_return_case_id', l.ebay_return_case_id,
          'order_number', coalesce(o.order_number, line_order.order_number, r.order_number),
          'order_buyer_username', coalesce(o.buyer_username, line_order.buyer_username),
          'order_buyer_name', coalesce(o.buyer_name, line_order.buyer_name),
          'order_buyer_email', coalesce(o.buyer_email, line_order.buyer_email),
          'item_number', ol.item_number,
          'transaction_id', ol.transaction_id,
          'custom_label', ol.custom_label,
          'item_title', ol.item_title,
          'ebay_return_id', r.ebay_return_id,
          'return_buyer_username', r.buyer_username,
          'return_status', r.status
        )) order by l.created_at desc, l.id) as link_rows,
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
          line_order.order_number,
          line_order.buyer_username,
          line_order.buyer_name,
          line_order.buyer_email,
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
      left join public.ebay_orders line_order on line_order.id = ol.order_id
      left join public.ebay_return_cases r on r.id = l.ebay_return_case_id
      where l.conversation_id = c.id
        and l.status in ('confirmed', 'suggested')
    ) link_stats on true
    left join lateral (
      select
        count(*) as message_row_count,
        bool_or(m.has_media) as has_media,
        coalesce(sum(m.media_count), 0)::integer as media_count,
        (array_agg(m.message_body_preview order by m.created_at_ebay desc nulls last, m.created_at desc) filter (where nullif(m.message_body_preview, '') is not null))[1] as latest_message_preview,
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
            and b.classification_latest_ebay_message_id is not null
            and b.latest_message_id is distinct from b.classification_latest_ebay_message_id
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
      and (cardinality(v_filter_sources) = 0 or b.derived_source = any(v_filter_sources))
      and (cardinality(v_filter_topics) = 0 or b.topic_tags @> v_filter_topics)
      and (cardinality(v_filter_buyer_flags) = 0 or b.buyer_flags @> v_filter_buyer_flags)
      and (cardinality(v_filter_risk_flags) = 0 or b.risk_flags @> v_filter_risk_flags)
      and (cardinality(v_filter_priorities) = 0 or (b.priority is not null and b.priority = any(v_filter_priorities)))
      and (cardinality(v_filter_response_needs) = 0 or (b.response_need is not null and b.response_need = any(v_filter_response_needs)))
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
          where position(term.value in b.search_text) = 0
        )
      )
  ),
  page_rows as (
    select *
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
      'shipping', count(*) filter (where topic_tags && array['shipping_issue', 'missing_item', 'order_status', 'delivery_timing']::text[]),
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
            and classification_latest_ebay_message_id is not null
            and latest_message_id is distinct from classification_latest_ebay_message_id
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
      'topics', coalesce((select jsonb_object_agg(value, row_count order by value) from (select value, count(*) as row_count from base, unnest(topic_tags) as topic(value) group by value) rows), '{}'::jsonb),
      'buyerFlags', coalesce((select jsonb_object_agg(value, row_count order by value) from (select value, count(*) as row_count from base, unnest(buyer_flags) as buyer_flag(value) group by value) rows), '{}'::jsonb),
      'riskFlags', coalesce((select jsonb_object_agg(value, row_count order by value) from (select value, count(*) as row_count from base, unnest(risk_flags) as risk_flag(value) group by value) rows), '{}'::jsonb),
      'priorities', coalesce((select jsonb_object_agg(priority, row_count order by priority) from (select priority, count(*) as row_count from base where priority is not null group by priority) rows), '{}'::jsonb),
      'responseNeeds', coalesce((select jsonb_object_agg(response_need, row_count order by response_need) from (select response_need, count(*) as row_count from base where response_need is not null group by response_need) rows), '{}'::jsonb)
    ) as counts
    from base
  )
  select jsonb_build_object(
    'ok', true,
    'rpc_version', 'v2_provider_read_state',
    'canonical_total', totals.canonical_total,
    'matching_total', totals.matching_total,
    'loaded_count', totals.loaded_count,
    'page_size', v_page_size,
    'offset', v_offset,
    'next_offset', case when v_offset + totals.loaded_count < totals.matching_total then v_offset + totals.loaded_count else null end,
    'has_more', v_offset + totals.loaded_count < totals.matching_total,
    'system_filter', v_system_filter,
    'search_terms', to_jsonb(v_search_terms),
    'structured_filters', v_structured_filters,
    'classification_filters', v_classification_filters,
    'smart_folder_counts', smart_counts.counts,
    'filter_option_counts', option_counts.counts,
    'conversations', coalesce((
      select jsonb_agg(
        jsonb_strip_nulls(jsonb_build_object(
          'id', p.id,
          'seller_account_id', p.seller_account_id,
          'seller_username', p.seller_username,
          'ebay_conversation_id', p.ebay_conversation_id,
          'conversation_type', p.conversation_type,
          'conversation_status', p.conversation_status,
          'conversation_title', p.conversation_title,
          'other_party_username', p.other_party_username,
          'reference_id', p.reference_id,
          'reference_type', p.reference_type,
          'unread_count', p.unread_count,
          'provider_read_state', p.provider_read_state,
          'local_read_state', p.local_read_state,
          'pending_provider_update', p.pending_provider_update,
          'last_provider_seen_at', p.last_provider_seen_at,
          'last_local_read_at', p.last_local_read_at,
          'last_read_sync_at', p.last_read_sync_at,
          'read_sync_status', p.read_sync_status,
          'read_sync_error', p.read_sync_error,
          'latest_message_id', p.latest_message_id,
          'latest_message_created_at', p.latest_message_created_at,
          'latest_message_preview', p.effective_latest_message_preview,
          'first_message_created_at', p.first_message_created_at,
          'last_message_created_at', p.last_message_created_at,
          'message_count', coalesce(p.message_count, p.message_row_count),
          'last_synced_at', p.last_synced_at,
          'last_detail_synced_at', p.last_detail_synced_at,
          'updated_at', p.updated_at,
          'created_at', p.created_at,
          'derived_source', p.derived_source,
          'effective_conversation_source', p.derived_source,
          'summary', jsonb_build_object(
            'link_count', p.link_count,
            'suggested_link_count', p.suggested_link_count,
            'has_order_link', p.has_order_link,
            'has_return_link', p.has_return_link,
            'has_media', p.has_media,
            'media_count', p.media_count,
            'message_count', p.message_row_count,
            'needs_context_review', p.link_count = 0 or p.suggested_link_count > 0,
            'links', p.link_rows
          ),
          'classification', case when p.classification_id is null then null else jsonb_strip_nulls(jsonb_build_object(
            'id', p.classification_id,
            'conversation_id', p.id,
            'latest_message_id', p.classification_latest_message_id,
            'latest_ebay_message_id', p.classification_latest_ebay_message_id,
            'conversation_source', p.classification_conversation_source,
            'classification_status', p.classification_status,
            'priority', p.priority,
            'response_need', p.response_need,
            'topic_tags', p.topic_tags,
            'buyer_flags', p.buyer_flags,
            'risk_flags', p.risk_flags,
            'confidence', p.confidence,
            'summary', p.classification_summary,
            'reasoning_summary', p.reasoning_summary,
            'recommended_action', p.recommended_action,
            'input_hash', p.input_hash,
            'context_hash', p.context_hash,
            'classifier_name', p.classifier_name,
            'classifier_version', p.classifier_version,
            'prompt_version', p.prompt_version,
            'model_name', p.model_name,
            'is_current', true,
            'review_state', p.review_state,
            'operator_override_payload', p.operator_override_payload,
            'operator_notes', p.operator_notes,
            'reviewed_by', p.reviewed_by,
            'reviewed_at', p.reviewed_at,
            'created_at', p.classification_created_at,
            'updated_at', p.classification_updated_at
          )) end
        ))
        order by p.latest_message_created_at desc nulls last, p.updated_at desc nulls last, p.id desc
      )
      from page_rows p
    ), '[]'::jsonb),
    'loaded_at', now()
  )
  into v_result
  from totals, smart_counts, option_counts;

  return v_result;
end;
$$;

revoke all on function public.get_ebay_canonical_mailbox_v2(integer, integer, text, text[], jsonb, jsonb) from public, anon;
grant execute on function public.get_ebay_canonical_mailbox_v2(integer, integer, text, text[], jsonb, jsonb) to authenticated;
grant execute on function public.get_ebay_canonical_mailbox_v2(integer, integer, text, text[], jsonb, jsonb) to service_role;

comment on function public.get_ebay_canonical_mailbox_v2(integer, integer, text, text[], jsonb, jsonb)
  is 'Versioned canonical eBay mailbox read model with provider/local read state for Step 5F.6P. Read-only; derives source from ebay_conversations.conversation_type.';
