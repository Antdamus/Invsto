begin;
do $$declare def text:=pg_get_functiondef('public.dispatch_ebay_finance_worker()'::regprocedure);
 marker text:='and not exists(select 1 from public.weekly_ebay_change_cursor where next_at<=now()) then return;';
begin
 if strpos(def,marker)=0 then raise exception 'Unexpected finance dispatcher';end if;
 execute replace(def,marker,'and not exists(select 1 from public.weekly_ebay_change_cursor where next_at<=now()) and public.next_ebay_requestor_month() is null then return;');
end$$;
update public.ebay_requestor_checks set due=now()-interval '1 day' where error is not null and checked is null;
commit;
