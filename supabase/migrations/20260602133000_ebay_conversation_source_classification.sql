-- Conversation source classification for canonical eBay messaging.
-- Additive only: separates member conversations from eBay platform notices
-- using the existing classification and saved-view systems.

alter table public.ebay_conversation_classifications
  add column if not exists conversation_source text not null default 'member_message'
  check (conversation_source in ('member_message', 'platform_notification'));

create index if not exists ebay_conversation_classifications_source_idx
  on public.ebay_conversation_classifications(conversation_source, created_at desc)
  where is_current = true;

update public.ebay_conversation_classifications classification
set conversation_source = case
    when conversation.conversation_type = 'FROM_EBAY' then 'platform_notification'
    else 'member_message'
  end
from public.ebay_conversations conversation
where classification.conversation_id = conversation.id
  and classification.conversation_source is distinct from case
    when conversation.conversation_type = 'FROM_EBAY' then 'platform_notification'
    else 'member_message'
  end;

insert into public.ebay_conversation_saved_views
  (name, description, filter_payload, system_key, is_system_default, sort_order)
values
  (
    'Members',
    'Buyer/member eBay message conversations.',
    '{"version":1,"system_filter":"members","search_query":"","classification_filters":{"sourceTypes":["member_message"],"topics":[],"buyerFlags":[],"riskFlags":[],"priorities":[],"responseNeeds":[]}}'::jsonb,
    'members',
    true,
    15
  ),
  (
    'eBay Notifications',
    'Platform notifications from eBay.',
    '{"version":1,"system_filter":"ebay_notifications","search_query":"","classification_filters":{"sourceTypes":["platform_notification"],"topics":[],"buyerFlags":[],"riskFlags":[],"priorities":[],"responseNeeds":[]}}'::jsonb,
    'ebay_notifications',
    true,
    16
  )
on conflict (system_key) where system_key is not null do update
set
  name = excluded.name,
  description = excluded.description,
  filter_payload = excluded.filter_payload,
  is_system_default = true,
  sort_order = excluded.sort_order,
  is_active = true,
  deleted_at = null,
  updated_at = now();
