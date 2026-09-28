-- Add one backward-compatible field in a short transaction before regression testing.
begin;
set local lock_timeout='500ms';
set local statement_timeout='5s';
alter table public.live_sale_sessions add column workflow_mode text not null default 'manual' check(workflow_mode in ('manual','ebay_live'));
commit;
