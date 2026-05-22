-- Step 4C.1 response draft persistence foundation.
-- Additive only: creates durable storage for future AI-generated response
-- drafts without generating, approving, sending, or mutating emails.

create table if not exists public.email_response_drafts (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.email_messages(id) on delete cascade,
  classification_id uuid references public.email_message_classifications(id) on delete set null,
  source text not null default 'ai'
    check (source in ('ai', 'human', 'template', 'rule')),
  draft_status text not null default 'generated'
    check (draft_status in ('generated', 'reviewing', 'approved', 'rejected', 'superseded', 'archived')),
  draft_subject text,
  draft_body_text text,
  draft_body_format text not null default 'plain_text'
    check (draft_body_format in ('plain_text', 'markdown', 'html')),
  model_name text,
  model_version text,
  prompt_version text,
  prompt_hash text,
  input_hash text,
  processing_job_id uuid references public.email_processing_jobs(id) on delete set null,
  draft_version integer not null default 1
    check (draft_version > 0),
  is_current boolean not null default true,
  superseded_at timestamptz,
  validation_status text not null default 'not_validated'
    check (validation_status in ('not_validated', 'valid', 'invalid', 'warning', 'error')),
  validation_errors jsonb not null default '[]'::jsonb,
  safety_flags text[] not null default '{}',
  requires_human_review boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  rejected_by uuid references auth.users(id) on delete set null,
  rejected_at timestamptz,
  operator_notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists email_response_drafts_message_idx
  on public.email_response_drafts(message_id);

create index if not exists email_response_drafts_classification_idx
  on public.email_response_drafts(classification_id)
  where classification_id is not null;

create index if not exists email_response_drafts_status_idx
  on public.email_response_drafts(draft_status);

create index if not exists email_response_drafts_current_idx
  on public.email_response_drafts(is_current);

create index if not exists email_response_drafts_created_idx
  on public.email_response_drafts(created_at desc);

create index if not exists email_response_drafts_message_current_idx
  on public.email_response_drafts(message_id, is_current);

create index if not exists email_response_drafts_classification_current_idx
  on public.email_response_drafts(classification_id, is_current)
  where classification_id is not null;

create index if not exists email_response_drafts_input_hash_idx
  on public.email_response_drafts(input_hash)
  where input_hash is not null;

create index if not exists email_response_drafts_processing_job_idx
  on public.email_response_drafts(processing_job_id)
  where processing_job_id is not null;

alter table public.email_response_drafts enable row level security;

revoke all on table public.email_response_drafts from public, anon, authenticated;

grant select, insert, update on table public.email_response_drafts to authenticated;
grant select, insert, update, delete on table public.email_response_drafts to service_role;

drop policy if exists "email_response_drafts_admin_select" on public.email_response_drafts;
create policy "email_response_drafts_admin_select"
on public.email_response_drafts
for select
to authenticated
using (
  exists (
    select 1
    from public.employees e
    where e.user_id = auth.uid()
      and e.active = true
      and e.role = 'admin'
  )
);

drop policy if exists "email_response_drafts_admin_insert" on public.email_response_drafts;
create policy "email_response_drafts_admin_insert"
on public.email_response_drafts
for insert
to authenticated
with check (
  exists (
    select 1
    from public.employees e
    where e.user_id = auth.uid()
      and e.active = true
      and e.role = 'admin'
  )
);

drop policy if exists "email_response_drafts_admin_update" on public.email_response_drafts;
create policy "email_response_drafts_admin_update"
on public.email_response_drafts
for update
to authenticated
using (
  exists (
    select 1
    from public.employees e
    where e.user_id = auth.uid()
      and e.active = true
      and e.role = 'admin'
  )
)
with check (
  exists (
    select 1
    from public.employees e
    where e.user_id = auth.uid()
      and e.active = true
      and e.role = 'admin'
  )
);

drop trigger if exists trg_email_response_drafts_updated_at
  on public.email_response_drafts;
create trigger trg_email_response_drafts_updated_at
before update on public.email_response_drafts
for each row execute function public.set_updated_at();
