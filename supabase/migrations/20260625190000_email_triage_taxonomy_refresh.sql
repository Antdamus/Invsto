-- Refresh eBay email triage taxonomy labels while preserving old records.

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'ebay_conversation_classifications'
      and con.conname in (
        'ebay_conversation_classifications_response_need_check',
        'ebay_conversation_classifications_topic_tags_check',
        'ebay_conversation_classifications_buyer_flags_check',
        'ebay_conversation_classifications_risk_flags_check'
      )
  loop
    execute format('alter table public.ebay_conversation_classifications drop constraint %I', constraint_name);
  end loop;
end $$;

alter table public.ebay_conversation_classifications
  add constraint ebay_conversation_classifications_response_need_check
  check (response_need in (
    'needs_reply',
    'reply_today',
    'needs_refund_decision',
    'needs_return_approval',
    'needs_shipping_follow_up',
    'needs_inventory_check',
    'needs_photos_evidence',
    'send_template_reply',
    'escalate_to_manager',
    'waiting_on_buyer',
    'waiting_on_carrier',
    'waiting_on_ebay',
    'resolved_closed',
    'reply_later',
    'no_reply_needed'
  )),
  add constraint ebay_conversation_classifications_topic_tags_check
  check (topic_tags <@ array[
    'return_request',
    'cancellation_request',
    'shipping_status_tracking',
    'shipping_problem',
    'payment_issue',
    'item_question',
    'condition_authenticity_question',
    'missing_item',
    'wrong_item_received',
    'not_as_described',
    'damage_claim',
    'refund_request',
    'buyer_complaint',
    'feedback_issue',
    'custom_order_question',
    'general_question',
    'platform_notice',
    'return',
    'cancellation',
    'shipping_issue',
    'wrong_item',
    'offer_question',
    'order_status',
    'delivery_timing',
    'address_change'
  ]::text[]),
  add constraint ebay_conversation_classifications_buyer_flags_check
  check (buyer_flags <@ array[
    'vip_buyer',
    'high_order_value',
    'repeat_buyer',
    'new_buyer',
    'return_prone_buyer',
    'low_risk_buyer',
    'high_value_buyer',
    'high_retained_value_buyer',
    'high_return_risk_buyer'
  ]::text[]),
  add constraint ebay_conversation_classifications_risk_flags_check
  check (risk_flags <@ array[
    'negative_feedback_risk',
    'case_dispute_risk',
    'fraud_abuse_risk',
    'high_dollar_risk',
    'deadline_sensitive',
    'angry_buyer',
    'manager_review',
    'high_return_risk',
    'context_review_needed',
    'low_confidence',
    'stale_context',
    'refund_risk',
    'chargeback_risk',
    'return_escalation_risk',
    'cancellation_risk',
    'buyer_unhappy',
    'unsupported_claim_risk'
  ]::text[]);

update public.ebay_conversation_saved_views
set
  name = 'High order value',
  description = 'Conversations tied to a high-value current order.',
  filter_payload = jsonb_build_object(
    'version', 2,
    'system_filter', 'high_value_buyers',
    'search_query', '',
    'classification_filters', jsonb_build_object(
      'sourceTypes', jsonb_build_array(),
      'topics', jsonb_build_array(),
      'buyerFlags', jsonb_build_array('high_order_value'),
      'riskFlags', jsonb_build_array(),
      'priorities', jsonb_build_array(),
      'responseNeeds', jsonb_build_array()
    ),
    'label_rules', jsonb_build_object(
      'operator', 'AND',
      'required_labels', jsonb_build_array('ai:high_order_value')
    )
  )
where system_key = 'high_value_buyers'
  and coalesce(is_system_default, false) = true;

do $$
declare
  function_name text;
  definition text;
begin
  foreach function_name in array array['get_ebay_canonical_mailbox', 'get_ebay_canonical_mailbox_v2']
  loop
    select pg_get_functiondef(p.oid)
    into definition
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = function_name
    order by p.oid desc
    limit 1;

    if definition is null then
      continue;
    end if;

    definition := replace(definition,
      'when ''returns'' then b.has_return_link or b.topic_tags @> array[''return'']::text[]',
      'when ''returns'' then b.has_return_link or b.topic_tags && array[''return_request'', ''return'']::text[]'
    );
    definition := replace(definition,
      'when ''shipping_issues'' then b.topic_tags && array[''shipping_issue'', ''missing_item'', ''order_status'', ''delivery_timing'']::text[]',
      'when ''shipping_issues'' then b.topic_tags && array[''shipping_problem'', ''shipping_status_tracking'', ''missing_item'', ''shipping_issue'', ''order_status'', ''delivery_timing'']::text[]'
    );
    definition := replace(definition,
      'when ''high_value_buyers'' then b.buyer_flags @> array[''high_value_buyer'']::text[]',
      'when ''high_value_buyers'' then b.buyer_flags && array[''high_order_value'', ''high_value_buyer'']::text[]'
    );
    definition := replace(definition,
      'when ''high_value_buyers'' then b.buyer_flags && array[''high_value_buyer'', ''high_retained_value_buyer'']::text[]',
      'when ''high_value_buyers'' then b.buyer_flags && array[''high_order_value'', ''high_value_buyer'']::text[]'
    );
    definition := replace(definition,
      '''returns'', count(*) filter (where has_return_link or topic_tags @> array[''return'']::text[])',
      '''returns'', count(*) filter (where has_return_link or topic_tags && array[''return_request'', ''return'']::text[])'
    );
    definition := replace(definition,
      '''shipping_issues'', count(*) filter (where topic_tags && array[''shipping_issue'', ''missing_item'', ''order_status'', ''delivery_timing'']::text[])',
      '''shipping_issues'', count(*) filter (where topic_tags && array[''shipping_problem'', ''shipping_status_tracking'', ''missing_item'', ''shipping_issue'', ''order_status'', ''delivery_timing'']::text[])'
    );
    definition := replace(definition,
      '''shipping'', count(*) filter (where topic_tags && array[''shipping_issue'', ''missing_item'', ''order_status'', ''delivery_timing'']::text[])',
      '''shipping'', count(*) filter (where topic_tags && array[''shipping_problem'', ''shipping_status_tracking'', ''missing_item'', ''shipping_issue'', ''order_status'', ''delivery_timing'']::text[])'
    );
    definition := replace(definition,
      '''high_value_buyers'', count(*) filter (where buyer_flags @> array[''high_value_buyer'']::text[])',
      '''high_value_buyers'', count(*) filter (where buyer_flags && array[''high_order_value'', ''high_value_buyer'']::text[])'
    );
    definition := replace(definition,
      '''high_value_buyers'', count(*) filter (where buyer_flags && array[''high_value_buyer'', ''high_retained_value_buyer'']::text[])',
      '''high_value_buyers'', count(*) filter (where buyer_flags && array[''high_order_value'', ''high_value_buyer'']::text[])'
    );

    execute definition;
  end loop;
end $$;
