begin;
set local lock_timeout='5s';
-- Expanded historical batches include delayed checkouts after the show window.
-- Give this admin-gated report RPC a bounded budget above the default 8 seconds.
alter function public.get_streamer_performance_history_range(date,date,date) set statement_timeout='45s';
notify pgrst,'reload schema';
commit;
