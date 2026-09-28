begin;
set local lock_timeout='500ms';
set local statement_timeout='5s';
alter table public.ebay_live_attempts add column merged_into uuid references public.ebay_live_attempts(id);
commit;
