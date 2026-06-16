-- Step 5F.6P.2D label visibility and smart-folder normalization.
-- Keeps the existing canonical mailbox RPC contract while making built-in
-- saved-view definitions label-shaped and auditable.

with built_in(system_key, name, description, sort_order, required_label) as (
  values
    ('all', 'All', 'All canonical eBay conversations.', 10, null),
    ('members', 'Members', 'Buyer/member eBay message conversations.', 15, 'system:members'),
    ('ebay_notifications', 'eBay Notifications', 'Platform notifications from eBay.', 16, 'system:ebay_notifications'),
    ('unread', 'Unread', 'Conversations with unread state.', 20, 'state:unread'),
    ('unclassified', 'Unclassified', 'Canonical eBay conversations with no current AI classification.', 21, 'state:unclassified'),
    ('returns', 'Returns', 'Conversations carrying the Returns label.', 30, 'system:returns'),
    ('shipping_issues', 'Shipping', 'Conversations carrying the Shipping label.', 40, 'system:shipping'),
    ('needs_reply_today', 'Reply today', 'Conversations carrying the Needs Reply Today state label.', 50, 'state:needs_reply_today'),
    ('vip_buyers', 'VIP buyers', 'Conversations carrying the VIP Buyer AI label.', 60, 'ai:vip_buyer'),
    ('high_value_buyers', 'High value', 'Conversations carrying the High Value Buyer AI label.', 70, 'ai:high_value_buyer'),
    ('refund_risk', 'Refund risk', 'Conversations carrying the Refund Risk AI label.', 80, 'ai:refund_risk'),
    ('review_queue', 'Review queue', 'Conversations carrying the Review Queue state label.', 90, 'state:review_queue'),
    ('has_order', 'Has order', 'Conversations carrying the Has Order system label.', 100, 'system:has_order'),
    ('has_return', 'Has return', 'Conversations carrying the Has Return system label.', 110, 'system:has_return'),
    ('has_media', 'Has media', 'Conversations carrying the Has Media system label.', 120, 'system:has_media'),
    ('needs_context_review', 'Needs review', 'Conversations carrying the Needs Review system label.', 130, 'system:needs_review')
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
        'required_labels', case
          when required_label is null then '[]'::jsonb
          else jsonb_build_array(required_label)
        end
      )
    ) as filter_payload
  from built_in
)
insert into public.ebay_conversation_saved_views
  (name, description, filter_payload, system_key, is_system_default, is_active, sort_order)
select
  name,
  description,
  filter_payload,
  system_key,
  true,
  true,
  sort_order
from payloads
on conflict (system_key) where system_key is not null do update
set
  name = excluded.name,
  description = excluded.description,
  filter_payload = excluded.filter_payload,
  is_system_default = true,
  is_active = true,
  sort_order = excluded.sort_order,
  deleted_at = null,
  updated_at = now();
