-- Immutable operational audit events for email triage replay, requeue, and sync recovery controls.
-- Operational writes are service-role only; browser clients can read as admins but cannot write.

create table if not exists public.email_operational_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null
    check (event_type in ('processing_requeue', 'processing_replay', 'sync_replay')),
  mailbox_id uuid references public.email_mailboxes(id) on delete set null,
  sync_run_id uuid references public.email_sync_runs(id) on delete set null,
  message_ids uuid[] not null default '{}'::uuid[],
  job_ids uuid[] not null default '{}'::uuid[],
  new_job_ids uuid[] not null default '{}'::uuid[],
  job_types text[] not null default '{}'::text[],
  reason text not null,
  initiated_by uuid references auth.users(id) on delete set null,
  initiated_by_email text,
  failure_category text,
  operational_notes text,
  processor_version text,
  replay_source text,
  idempotency_key text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.email_operational_events enable row level security;

revoke all on table public.email_operational_events from public, anon, authenticated;

grant select on table public.email_operational_events to authenticated;
grant select, insert on table public.email_operational_events to service_role;

drop policy if exists "email_operational_events_admin_select" on public.email_operational_events;
create policy "email_operational_events_admin_select"
on public.email_operational_events
for select
to authenticated
using (public.is_admin());

create index if not exists email_operational_events_type_created_idx
  on public.email_operational_events(event_type, created_at desc);

create index if not exists email_operational_events_mailbox_created_idx
  on public.email_operational_events(mailbox_id, created_at desc)
  where mailbox_id is not null;

create index if not exists email_operational_events_sync_run_idx
  on public.email_operational_events(sync_run_id)
  where sync_run_id is not null;

create index if not exists email_operational_events_message_ids_idx
  on public.email_operational_events using gin(message_ids);

create unique index if not exists email_operational_events_idempotency_key_uidx
  on public.email_operational_events(idempotency_key)
  where idempotency_key is not null;
