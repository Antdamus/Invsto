-- Persistent Microsoft mailbox connection foundation for Email Triage.
-- Token material stays out of browser-readable metadata and belongs only in
-- the service-role-only secrets table after Edge Function encryption.

create table if not exists public.microsoft_mailbox_connections (
  id uuid primary key default gen_random_uuid(),
  mailbox_email text not null,
  microsoft_user_id text not null,
  display_name text,
  connected_by uuid references auth.users(id) on delete set null,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status text not null default 'connected'
    check (status in ('connected', 'disconnected', 'error', 'reconnect_required')),
  scopes text[] not null default '{}',
  tenant_id_or_authority text not null,
  access_token_expires_at timestamptz,
  last_successful_check_at timestamptz,
  last_error_code text,
  last_error_at timestamptz,
  disconnected_at timestamptz,
  disconnected_by uuid references auth.users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  unique (microsoft_user_id)
);

create table if not exists public.microsoft_mailbox_connection_secrets (
  connection_id uuid primary key
    references public.microsoft_mailbox_connections(id) on delete cascade,
  refresh_token_ciphertext text not null,
  refresh_token_iv text not null,
  refresh_token_key_version text not null default 'v1',
  refresh_token_last_rotated_at timestamptz not null default now(),
  refresh_token_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists microsoft_mailbox_connections_email_lower_uidx
  on public.microsoft_mailbox_connections (lower(mailbox_email));

create unique index if not exists microsoft_mailbox_connections_single_active_uidx
  on public.microsoft_mailbox_connections ((true))
  where status in ('connected', 'error', 'reconnect_required');

create index if not exists microsoft_mailbox_connections_status_idx
  on public.microsoft_mailbox_connections(status, updated_at desc);

create index if not exists microsoft_mailbox_connections_connected_by_idx
  on public.microsoft_mailbox_connections(connected_by, connected_at desc);

create index if not exists microsoft_mailbox_connection_secrets_rotated_idx
  on public.microsoft_mailbox_connection_secrets(refresh_token_last_rotated_at desc);

alter table public.microsoft_mailbox_connections enable row level security;
alter table public.microsoft_mailbox_connection_secrets enable row level security;

revoke all on table public.microsoft_mailbox_connections from public;
revoke all on table public.microsoft_mailbox_connections from anon;
revoke all on table public.microsoft_mailbox_connections from authenticated;

revoke all on table public.microsoft_mailbox_connection_secrets from public;
revoke all on table public.microsoft_mailbox_connection_secrets from anon;
revoke all on table public.microsoft_mailbox_connection_secrets from authenticated;

grant select on table public.microsoft_mailbox_connections to authenticated;
grant select, insert, update, delete on table public.microsoft_mailbox_connections to service_role;
grant select, insert, update, delete on table public.microsoft_mailbox_connection_secrets to service_role;

drop policy if exists "microsoft_mailbox_connections_active_admin_select"
  on public.microsoft_mailbox_connections;
create policy "microsoft_mailbox_connections_active_admin_select"
on public.microsoft_mailbox_connections
for select
to authenticated
using (
  public.is_admin()
  and exists (
    select 1
    from public.employees e
    where e.user_id = auth.uid()
      and e.active = true
      and e.role = 'admin'
  )
);

drop trigger if exists trg_microsoft_mailbox_connections_updated_at
  on public.microsoft_mailbox_connections;
create trigger trg_microsoft_mailbox_connections_updated_at
before update on public.microsoft_mailbox_connections
for each row execute function public.set_updated_at();

drop trigger if exists trg_microsoft_mailbox_connection_secrets_updated_at
  on public.microsoft_mailbox_connection_secrets;
create trigger trg_microsoft_mailbox_connection_secrets_updated_at
before update on public.microsoft_mailbox_connection_secrets
for each row execute function public.set_updated_at();
