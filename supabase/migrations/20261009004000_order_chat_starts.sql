-- Initial seller messages have no conversation/draft until eBay accepts them.
-- Keep their delivery ledger separate from reply approvals; never invent an eBay ID.
create table if not exists public.ebay_order_chat_starts (
  id uuid primary key,
  order_line_id uuid not null references public.ebay_order_lines(id),
  seller_account_id uuid not null references public.ebay_seller_accounts(id),
  buyer_username text not null,
  body_sha256 text not null,
  message_text text not null check (length(message_text) between 1 and 2000),
  status text not null check (status in ('sending', 'sent', 'failed', 'unknown')),
  conversation_id uuid references public.ebay_conversations(id),
  provider_conversation_id text,
  provider_message_id text,
  provider_response jsonb not null default '{}'::jsonb,
  error_message text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists ebay_order_chat_starts_one_delivery_idx
  on public.ebay_order_chat_starts(order_line_id)
  where status in ('sending', 'sent', 'unknown');
alter table public.ebay_order_chat_starts enable row level security;
revoke all on public.ebay_order_chat_starts from public, anon, authenticated;
grant select, insert, update on public.ebay_order_chat_starts to service_role;
comment on table public.ebay_order_chat_starts is
  'Human-initiated first-message ledger. Unknown delivery blocks automatic resend.';
