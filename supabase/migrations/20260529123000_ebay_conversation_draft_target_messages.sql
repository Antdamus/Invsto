-- Message-targeted AI draft persistence for canonical eBay conversations.
-- Adds draft target metadata only. No send, mark-read, archive, delete, eBay
-- mutation, return mutation, or Outlook mutation behavior is introduced here.

alter table public.ebay_conversation_response_drafts
  add column if not exists target_message_id uuid
    references public.ebay_conversation_messages(id) on delete set null;

create index if not exists ebay_conversation_response_drafts_target_message_idx
  on public.ebay_conversation_response_drafts(target_message_id)
  where target_message_id is not null;

comment on column public.ebay_conversation_response_drafts.target_message_id
  is 'Inbound eBay conversation message this operator-reviewed AI draft is intended to answer.';
