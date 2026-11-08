begin;
set local lock_timeout='5s';
-- Only the internal evidence RPC can create a batch marker. Ordinary order
-- writes continue to reconcile immediately. Queued work completes in the same
-- transaction, once per event, before the evidence refresh can commit.
create table public.ebay_show_reconcile_batch (
 transaction_id bigint not null,event_id text not null,
 primary key(transaction_id,event_id)
);
alter table public.ebay_show_reconcile_batch enable row level security;
revoke all on public.ebay_show_reconcile_batch from public,anon,authenticated,service_role;
do $$declare f text; sig text; marker text; event_var text;
begin
 foreach sig in array array['public.ebay_live_order_changed()','public.ebay_live_order_lines_changed_statement()'] loop
  f:=pg_get_functiondef(sig::regprocedure);
  event_var:=case when sig='public.ebay_live_order_changed()' then 'v_event' else 'event_id_to_check' end;
  marker:='perform public.reconcile_ebay_live_orders_internal('||event_var||');';
  if strpos(f,marker)=0 then raise exception 'Unexpected live reconciliation trigger %',sig;end if;
  execute replace(f,marker,'if exists(select 1 from public.ebay_show_reconcile_batch where transaction_id=txid_current() and event_id='''') then
   insert into public.ebay_show_reconcile_batch values(txid_current(),'||event_var||') on conflict do nothing;
   else '||marker||' end if;');
 end loop;
 f:=pg_get_functiondef('public.reconcile_ebay_show_orders(jsonb,boolean)'::regprocedure);
 marker:='for o in select value from jsonb_array_elements(_orders)';
 if strpos(f,marker)=0 then raise exception 'Unexpected evidence loop';end if;
 f:=replace(f,marker,'if not _dry_run then insert into public.ebay_show_reconcile_batch values(txid_current(),'''');end if; '||marker);
 marker:='return jsonb_build_object(''dryRun'',_dry_run';
 if strpos(f,marker)=0 then raise exception 'Unexpected evidence result';end if;
 f:=replace(f,marker,'if not _dry_run then
  delete from public.ebay_show_reconcile_batch where transaction_id=txid_current() and event_id='''';
  for number in select event_id from public.ebay_show_reconcile_batch where transaction_id=txid_current() order by event_id loop
   perform public.reconcile_ebay_live_orders_internal(number);
  end loop;
  delete from public.ebay_show_reconcile_batch where transaction_id=txid_current();
 end if; '||marker);
 execute f;
end$$;
notify pgrst,'reload schema';
commit;
