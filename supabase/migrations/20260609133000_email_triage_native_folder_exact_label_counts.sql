-- Step 5F.6P.2E native smart-folder exact label normalization.
-- Keeps native folders label-shaped and makes canonical RPC counts/results
-- match the visible label chips for VIP Buyer, High Value Buyer, and Refund Risk.

with native(system_key, name, description, sort_order, required_label) as (
  values
    ('vip_buyers', 'VIP buyers', 'Conversations carrying the VIP Buyer AI label.', 60, 'ai:vip_buyer'),
    ('high_value_buyers', 'High value', 'Conversations carrying the High Value Buyer AI label.', 70, 'ai:high_value_buyer'),
    ('refund_risk', 'Refund risk', 'Conversations carrying the Refund Risk AI label.', 80, 'ai:refund_risk')
),
payloads as (
  select
    system_key,
    name,
    description,
    sort_order,
    jsonb_build_object(
      'version', 2,
      'system_filter', system_key,
      'search_query', '',
      'classification_filters', jsonb_build_object(
        'sourceTypes', '[]'::jsonb,
        'topics', '[]'::jsonb,
        'buyerFlags', '[]'::jsonb,
        'riskFlags', '[]'::jsonb,
        'priorities', '[]'::jsonb,
        'responseNeeds', '[]'::jsonb
      ),
      'label_rules', jsonb_build_object(
        'operator', 'AND',
        'required_labels', jsonb_build_array(required_label)
      )
    ) as filter_payload
  from native
)
update public.ebay_conversation_saved_views v
set
  name = p.name,
  description = p.description,
  filter_payload = p.filter_payload,
  is_system_default = true,
  is_active = true,
  sort_order = p.sort_order,
  deleted_at = null,
  updated_at = now()
from payloads p
where v.system_key = p.system_key;

do $$
declare
  v_signature regprocedure := 'public.get_ebay_canonical_mailbox_v2(integer, integer, text, text[], jsonb, jsonb)'::regprocedure;
  v_sql text;
  v_next text;
begin
  v_sql := pg_get_functiondef(v_signature);
  v_next := v_sql;

  v_next := replace(
    v_next,
    'when ''vip_buyers'' then b.buyer_flags && array[''vip_buyer'']::text[]',
    'when ''vip_buyers'' then b.buyer_flags @> array[''vip_buyer'']::text[]'
  );
  v_next := replace(
    v_next,
    'when ''high_value_buyers'' then b.buyer_flags && array[''high_value_buyer'', ''high_retained_value_buyer'']::text[]',
    'when ''high_value_buyers'' then b.buyer_flags @> array[''high_value_buyer'']::text[]'
  );
  v_next := replace(
    v_next,
    'when ''refund_risk'' then b.risk_flags && array[''refund_risk'', ''chargeback_risk'', ''unsupported_claim_risk'']::text[]',
    'when ''refund_risk'' then b.risk_flags @> array[''refund_risk'']::text[]'
  );
  v_next := replace(
    v_next,
    '''vip_buyers'', count(*) filter (where buyer_flags && array[''vip_buyer'']::text[])',
    '''vip_buyers'', count(*) filter (where buyer_flags @> array[''vip_buyer'']::text[])'
  );
  v_next := replace(
    v_next,
    '''high_value_buyers'', count(*) filter (where buyer_flags && array[''high_value_buyer'', ''high_retained_value_buyer'']::text[])',
    '''high_value_buyers'', count(*) filter (where buyer_flags @> array[''high_value_buyer'']::text[])'
  );
  v_next := replace(
    v_next,
    '''refund_risk'', count(*) filter (where risk_flags && array[''refund_risk'', ''chargeback_risk'', ''unsupported_claim_risk'']::text[])',
    '''refund_risk'', count(*) filter (where risk_flags @> array[''refund_risk'']::text[])'
  );

  if v_next = v_sql then
    raise exception 'native_folder_exact_label_rpc_branches_not_found';
  end if;

  execute v_next;
end;
$$;

comment on function public.get_ebay_canonical_mailbox_v2(integer, integer, text, text[], jsonb, jsonb)
  is 'Versioned canonical eBay mailbox read model with exact native label smart folders for VIP Buyer, High Value Buyer, and Refund Risk. Read-only; no eBay mutation.';
