begin;
set local lock_timeout='500ms';
set local statement_timeout='5s';
alter table public.ebay_live_connections
 add column broadcast_ended_at timestamptz,
 add column broadcast_end_source text,
 add column review_completed_at timestamptz,
 add column review_completed_by uuid references auth.users(id);
commit;
