begin;
set local lock_timeout='500ms';
set local statement_timeout='5s';
-- A draft is an unfinished inventory session, not a closed eBay broadcast.
alter table public.live_sale_sessions
 add column saved_for_later_at timestamptz,
 add column saved_for_later_by uuid references auth.users(id);
commit;
