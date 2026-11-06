begin;
set local lock_timeout='5s';
alter table public.whatnot_api_connection
 add column recent_page_cursor text,
 add column recent_sync_started_at timestamptz,
 add column recent_sync_from timestamptz,
 add column recent_synced_at timestamptz;
comment on column public.whatnot_api_connection.recent_page_cursor is 'Independent newest-first pagination so new orders do not wait for the historical import.';
commit;
