begin;
do $$declare f text:=pg_get_functiondef('public.get_weekly_sales_for_market(date,text)'::regprocedure);
 marker text:='''ebay_account_payouts'',';begin
 if strpos(f,marker)=0 then raise exception 'Unexpected payout report';end if;
 execute replace(f,marker,$x$'ebay_payout_coverage',case when _market in ('ebay','all') then
 (select jsonb_build_object('error',s.last_error,'last_success',s.last_success,'done',(select count(*) from public.weekly_ebay_payout_batches where reported_day>=m and reported_day<end_date and status='SUCCEEDED' and currency='USD' and detail_checked is not null and detail_error is null),
 'retry',(select count(*) from public.weekly_ebay_payout_batches where reported_day>=m and reported_day<end_date and status='SUCCEEDED' and currency='USD' and detail_error is not null))
 from public.weekly_ebay_payout_scan s where singleton) end,'ebay_account_payouts',$x$);
end$$;
notify pgrst,'reload schema';
commit;
