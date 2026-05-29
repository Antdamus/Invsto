-- AI response draft persistence for canonical eBay conversations.
-- Draft-only infrastructure: no send, mark-read, archive, delete, eBay mutation,
-- return mutation, or Outlook mutation behavior is introduced here.

create table if not exists public.ebay_conversation_response_drafts (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.ebay_conversations(id) on delete cascade,
  latest_message_id uuid references public.ebay_conversation_messages(id) on delete set null,
  classification_id uuid references public.ebay_conversation_classifications(id) on delete set null,
  draft_status text not null default 'generated'
    check (draft_status in ('generated', 'edited', 'saved', 'discarded', 'superseded', 'error')),
  draft_text text,
  edited_text text,
  final_text text,
  source_mode text not null default 'generate'
    check (source_mode in ('generate', 'regenerate', 'improve', 'operator_edit', 'system_fallback')),
  model_name text,
  prompt_version text,
  prompt_hash text,
  input_hash text,
  context_hash text,
  grounding_summary jsonb not null default '{}'::jsonb,
  safety_warnings jsonb not null default '[]'::jsonb,
  validation_status text not null default 'not_validated'
    check (validation_status in ('not_validated', 'valid', 'warning', 'invalid', 'error')),
  validation_errors jsonb not null default '[]'::jsonb,
  ai_output jsonb not null default '{}'::jsonb,
  input_snapshot jsonb not null default '{}'::jsonb,
  operator_notes text,
  confidence numeric(5,4) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  draft_version integer not null default 1 check (draft_version > 0),
  is_current boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  discarded_at timestamptz,
  superseded_at timestamptz
);

create index if not exists ebay_conversation_response_drafts_conversation_idx
  on public.ebay_conversation_response_drafts(conversation_id, created_at desc);

create index if not exists ebay_conversation_response_drafts_latest_message_idx
  on public.ebay_conversation_response_drafts(latest_message_id)
  where latest_message_id is not null;

create index if not exists ebay_conversation_response_drafts_classification_idx
  on public.ebay_conversation_response_drafts(classification_id)
  where classification_id is not null;

create index if not exists ebay_conversation_response_drafts_status_idx
  on public.ebay_conversation_response_drafts(draft_status, created_at desc);

create index if not exists ebay_conversation_response_drafts_current_idx
  on public.ebay_conversation_response_drafts(conversation_id, is_current)
  where is_current = true;

create unique index if not exists ebay_conversation_response_drafts_one_current_uidx
  on public.ebay_conversation_response_drafts(conversation_id)
  where is_current = true and discarded_at is null;

create index if not exists ebay_conversation_response_drafts_input_hash_idx
  on public.ebay_conversation_response_drafts(input_hash)
  where input_hash is not null;

alter table public.ebay_conversation_response_drafts enable row level security;

revoke all on table public.ebay_conversation_response_drafts from public, anon, authenticated;

grant select on table public.ebay_conversation_response_drafts to authenticated;
grant select, insert, update, delete on table public.ebay_conversation_response_drafts to service_role;

drop policy if exists "ebay_conversation_response_drafts_staff_select" on public.ebay_conversation_response_drafts;
create policy "ebay_conversation_response_drafts_staff_select"
on public.ebay_conversation_response_drafts
for select
to authenticated
using (public.can_manage_inventory());

drop trigger if exists trg_ebay_conversation_response_drafts_updated_at
  on public.ebay_conversation_response_drafts;
create trigger trg_ebay_conversation_response_drafts_updated_at
before update on public.ebay_conversation_response_drafts
for each row execute function public.touch_ebay_messaging_updated_at();
